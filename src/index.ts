import { createBot, CONTRIBUTOR_COMMANDS, ADMIN_COMMANDS } from './bot/index.js';
import { config } from './config.js';
import { aiEnabled } from './ai/assist.js';
import { startWorker, stopWorker } from './bot/worker.js';

async function main(): Promise<void> {
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
    ...[...config.adminIds].map((adminId) =>
      bot.telegram
        .setMyCommands([...ADMIN_COMMANDS, ...CONTRIBUTOR_COMMANDS], { scope: { type: 'chat', chat_id: adminId } })
        .catch(menuFail(`admin ${adminId}`)),
    ),
  ]);

  const shutdown = (signal: string) => {
    stopWorker();
    try {
      bot.stop(signal);
    } catch {
      // launch() has not started polling yet (or already stopped) — Telegraf's
      // stop() throws "Bot is not running!". There is nothing to wind down,
      // and swallowing the signal would let polling start AFTER the shutdown
      // request, so exit plainly instead.
      process.exit(0);
    }
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // launch() resolves only once the bot stops, so start it without awaiting.
  bot.launch().catch((err) => {
    console.error('Bot stopped with error:', err);
    process.exit(1);
  });

  // Single global notification worker: drains the queue, rate-limited, with retries.
  startWorker(bot.telegram);

  console.log('🤖 MultiAgency bot is running (long polling).');
  console.log(`   Admins: ${config.adminIds.size} · AI assist: ${aiEnabled() ? 'on' : 'off'} · notify: ${config.notifyRatePerSec}/s`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
