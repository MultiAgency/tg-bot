import { createBot, CONTRIBUTOR_COMMANDS, ADMIN_COMMANDS, GROUP_COMMANDS } from './bot/index.js';
import { config } from './config.js';
import { aiEnabled } from './ai/assist.js';
import { initSchema, closePool } from './core/db.js';
import { reclaimStaleSignals } from './core/service.js';
import { startWorker, stopWorker } from './bot/worker.js';
import { drainDetached, beginShutdown } from './bot/background.js';

async function main(): Promise<void> {
  // Apply pending migrations before anything touches the database.
  await initSchema();

  // Clear any signal slot left 'evaluating' by a prior process that died
  // mid-evaluation (SIGKILL/crash) — a graceful shutdown discards its own, so
  // this only catches unclean deaths. Single writer: nothing else is running.
  const reclaimed = await reclaimStaleSignals();
  if (reclaimed > 0) console.log(`[signals] reclaimed ${reclaimed} orphaned evaluation(s) from a prior run`);

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

  // launch() resolves only once the bot stops, so start it without awaiting.
  const launched = bot.launch().catch((err) => {
    console.error('Bot stopped with error:', err);
    process.exit(1);
  });

  const shutdown = async (signal: string): Promise<void> => {
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
    await Promise.all([stopWorker(), drainDetached()]);
    await closePool();
    if (!polling) process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Single global notification worker: drains the queue, rate-limited, with retries.
  startWorker(bot.telegram);

  console.log('🤖 MultiAgency bot is running (long polling).');
  console.log(`   Admins: ${config.adminIds.size} · AI assist: ${aiEnabled() ? 'on' : 'off'} · notify: ${config.notifyRatePerSec}/s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
