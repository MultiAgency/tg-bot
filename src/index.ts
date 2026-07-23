import { createBot, CONTRIBUTOR_COMMANDS, ADMIN_COMMANDS, GROUP_COMMANDS } from './bot/index.js';
import { config } from './config.js';
import { aiEnabled } from './ai/assist.js';
import { initSchema, closePool } from './core/db.js';
import { reclaimStaleSignals, setPayoutPaidNotifier } from './core/service.js';
import { startWorker, stopWorker, setGiveUpAlerter, setStaleNudger } from './bot/worker.js';
import { setAnnounceChatNumericId, notifyPayoutPaid, notifyOpsGiveUp, nudgeStaleAssignments } from './bot/notify.js';
import { drainDetached, beginShutdown } from './bot/background.js';
import { startWebServer, stopWebServer, setPollerStatus } from './web/server.js';
import { TelegramError } from 'telegraf';

async function main(): Promise<void> {
  // Apply pending migrations before anything touches the database.
  await initSchema();

  // Clear any signal slot left 'evaluating' by a prior process that died
  // mid-evaluation (SIGKILL/crash) — a graceful shutdown discards its own, so
  // this only catches unclean deaths. Single writer: nothing else is running.
  const reclaimed = await reclaimStaleSignals();
  if (reclaimed > 0) console.log(`[signals] reclaimed ${reclaimed} orphaned evaluation(s) from a prior run`);

  // The reconciler DMs a contributor when their payout lands (dedup-keyed, via
  // the notification queue) — registered here so core/ never imports bot/.
  setPayoutPaidNotifier(notifyPayoutPaid);

  // Minimal delivery alerting: retry-exhausted transient send failures fan a
  // throttled summary to global admins — registered here (same pattern as
  // above) so worker.ts never imports notify.ts, which imports it.
  setGiveUpAlerter(notifyOpsGiveUp);

  // Pre-stale assignment nudges (a fair warning before /unassign territory) —
  // swept from the worker's leader tick; injected here, same seam as above.
  setStaleNudger(nudgeStaleAssignments);

  const bot = createBot();

  // Contributor commands are the default menu; admin commands appear only in
  // admins' own chats (per-chat scope). Failures are non-fatal (the commands
  // still work without a menu) but must be logged — a 429 in this parallel
  // burst would otherwise silently leave an admin without their menu until
  // some future restart.
  const menuFail = (scope: string) => (err: unknown) =>
    console.error(`[startup] setMyCommands (${scope}) failed:`, err instanceof Error ? err.message : err);
  await Promise.all([
    bot.telegram.setMyCommands(CONTRIBUTOR_COMMANDS).catch(menuFail('default')),
    bot.telegram
      .setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } })
      .catch(menuFail('groups')),
    ...[...config.adminIds].map((adminId) =>
      bot.telegram
        .setMyCommands([...ADMIN_COMMANDS, ...CONTRIBUTOR_COMMANDS], { scope: { type: 'chat', chat_id: adminId } })
        .catch(menuFail(`admin ${adminId}`)),
    ),
  ]);

  // ANNOUNCE_CHAT_ID accepts an @username, but the room-vs-channel announce
  // dedup compares numeric room ids — resolve it once so a room that IS the
  // announce chat doesn't get every approval posted twice. Best-effort: on
  // failure the dedup falls back to raw-string comparison (as before).
  if (config.announceChatId.startsWith('@')) {
    try {
      const chat = await bot.telegram.getChat(config.announceChatId);
      setAnnounceChatNumericId(chat.id);
    } catch (err) {
      console.warn('[startup] could not resolve ANNOUNCE_CHAT_ID username:', err instanceof Error ? err.message : err);
    }
  }

  // Point the chat menu button (next to the input field) at the Mini App, when
  // its public origin is configured. Non-fatal like the command menus.
  if (config.webAppUrl) {
    await bot.telegram
      .setChatMenuButton({ menuButton: { type: 'web_app', text: 'Board', web_app: { url: config.webAppUrl } } })
      .catch(menuFail('web_app menu button'));
  }

  // launch() resolves only once the bot stops (graceful) and rejects on a fatal
  // poll error. A 409 Conflict is NOT fatal: during a deploy rollover the old
  // container can keep long-polling the token for up to ~50s before Telegram
  // releases it. The old behaviour (process.exit on any launch error) turned that
  // transient overlap into a crash-loop that never cut over — the dying container
  // never held the token long enough to displace the old poller. Instead, keep
  // the process (and the web server below, so the platform sees a live instance)
  // up and retry launch with backoff until the other poller drops. Telegraf news
  // up a fresh Polling per launch(), so re-calling is safe. 401 (bad token) and
  // every other error stay fatal. A graceful stop() resolves launch() (no throw);
  // the backoff is cancelable so shutdown never waits it out.
  let shuttingDown = false;
  let wakeFromBackoff: (() => void) | null = null;
  // /healthz's poller field: the web tier can be green while this loop is
  // wedged in 409 backoff, silently receiving no updates — the one liveness
  // gap README concedes the bot can't self-report. Now it can, to whatever
  // external check watches /healthz.
  let pollerBackoff = false;
  setPollerStatus(() => (pollerBackoff ? 'backoff' : 'up'));
  const launchWithRetry = async (): Promise<void> => {
    for (let attempt = 0; !shuttingDown; attempt++) {
      // A relaunch only counts as recovered once it survives its first
      // getUpdates round-trip (a 409 surfaces within seconds) — resetting
      // eagerly would flash 'up' at a /healthz monitor mid-backoff.
      const recovered = setTimeout(() => {
        pollerBackoff = false;
      }, 10_000);
      try {
        await bot.launch();
        return; // resolved => stop() was called (graceful shutdown)
      } catch (err) {
        clearTimeout(recovered);
        if (shuttingDown) return; // shutting down; let shutdown() finish the exit
        if (!(err instanceof TelegramError && err.code === 409)) {
          console.error('Bot stopped with error:', err);
          process.exit(1);
        }
        pollerBackoff = true;
        const delayMs = Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 4));
        console.warn(
          `[launch] 409 Conflict — another getUpdates poller still holds the token ` +
            `(deploy rollover?); retrying in ${delayMs / 1000}s`,
        );
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delayMs);
          wakeFromBackoff = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wakeFromBackoff = null;
      }
    }
  };
  const launched = launchWithRetry();

  const shutdown = async (signal: string): Promise<void> => {
    shuttingDown = true;
    wakeFromBackoff?.(); // interrupt a pending relaunch backoff so shutdown isn't held
    // Abort cancelable in-flight work up front — the detached signal/review AI
    // calls AND a /newtask wizard's in-flight /ai draft — so neither pins the
    // update-handler drain (`await launched`) nor the detached drain for the
    // model's 30s timeout. Must precede `await launched`: bot.stop() aborts only
    // the getUpdates poll, not an in-flight handler.
    beginShutdown();
    let polling = true;
    try {
      bot.stop(signal);
    } catch {
      // launch() has not started polling yet (or already stopped) — Telegraf's
      // stop() throws "Bot is not running!". There is nothing to wind down,
      // and swallowing the signal would let polling start AFTER the shutdown
      // request, so clean up and exit plainly instead (below).
      polling = false;
    }
    // Order matters: stop intake first, let in-flight update handlers drain
    // (launch() resolves once polling has fully stopped), let the worker finish
    // its current send and any detached background work (signal evaluation, the
    // AI review note — each opens its own transaction) finish — only THEN close
    // the pool, so no query runs after pool.end() (which would strand a
    // delivered-but-unmarked notification, or a signal draft, for re-delivery /
    // loss on the next boot). Worker and detached drain in parallel; both are
    // internally bounded so neither pins shutdown past the grace window.
    if (polling) await launched;
    // Stop the web server alongside the worker/detached drain — it must stop
    // accepting requests before closePool(), or an in-flight web read could
    // query a closed pool.
    await Promise.all([stopWorker(), drainDetached(), stopWebServer()]);
    await closePool();
    if (!polling) process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Single global notification worker: drains the queue, rate-limited, with retries.
  startWorker(bot.telegram);

  // Mini App web tier, in-process, when a port is configured (off by default).
  if (config.webPort) startWebServer(config.webPort);

  console.log('🤖 MultiAgency bot is running (long polling).');
  console.log(`   Admins: ${config.adminIds.size} · AI assist: ${aiEnabled() ? 'on' : 'off'} · notify: ${config.notifyRatePerSec}/s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
