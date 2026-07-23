/**
 * Local preview of the Mini App: seed a throwaway DB, serve the built web app +
 * API on a port, and print a URL carrying a signed initData so it opens straight
 * to the board outside Telegram (the server still validates the signature). Dev
 * only — never runtime code. Stop with Ctrl+C.
 */
import { serve } from '@hono/node-server';
import { createWebApp } from '../src/web/server.js';
import { signInitData } from '../src/web/auth.js';
import { config } from '../src/config.js';
import { resetDb } from './testdb.js';
import { closePool, dropTestSchema } from '../src/core/db.js';
import {
  createTask,
  approveTask,
  apply,
  upsertContributor,
  assignApplication,
  submitWork,
  reviewSubmission,
} from '../src/core/service.js';

const PORT = 8787;
const ADMIN = 1;
const ADA = 42;

async function main(): Promise<void> {
  // Throwaway means THROWAWAY: run bare, this script inherits .env's dev
  // DATABASE_URL, and resetDb's guard lets it through (the dev db is localhost
  // too) — exactly how it once wiped live pass state mid-session. `npm run
  // preview` pins the *_test database; refuse everything else.
  const dbName = new URL(config.databaseUrl).pathname.slice(1);
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `preview refused: DATABASE_URL points at "${dbName}", not a *_test database — run it via \`npm run preview\`.`,
    );
  }
  await resetDb();
  await upsertContributor(ADA, 'ada', 'Ada Lovelace', 'en');

  // A handful of open tasks for the board.
  const open = [
    { title: 'Write the launch thread', description: 'Draft a 6-tweet thread announcing the pilot. Punchy, no hype.', reward: '50 USDC', deadline: 'Fri 18:00 UTC' },
    { title: 'Translate onboarding docs to Spanish', description: 'The /docs onboarding pages, faithful and natural.', reward: '120 NEAR', deadline: 'in 5 days' },
    { title: 'Design a room-admin settings mockup', description: 'One screen, Figma or hand-drawn, showing the signal + AI toggles.', reward: 'swag pack', deadline: null },
  ];
  for (const t of open) {
    const task = await createTask({ ...t, createdBy: ADMIN });
    await approveTask(task.id, ADMIN);
  }

  // Ada applied to the first, and completed a rewarded one → a payout.
  const applied = await createTask({ title: 'Audit the notification queue', description: 'Look for lost-DM edge cases.', reward: '80 USDC', deadline: 'Mon', createdBy: ADMIN });
  await approveTask(applied.id, ADMIN);
  await apply(applied.id, ADA, 'I wrote the original outbox — happy to audit it.');

  const paid = await createTask({ title: 'Fix the pagination off-by-one', description: 'Applicants list skipped the last row on page 2.', reward: '40 USDC', deadline: 'done', createdBy: ADMIN });
  await approveTask(paid.id, ADMIN);
  const app = await apply(paid.id, ADA, 'On it.');
  await assignApplication(app.id, ADMIN);
  const { submission } = await submitWork(app.id, ADA, 'link', 'https://github.com/multi/bot/pull/7');
  await reviewSubmission(submission.id, ADMIN, 'approve', null);

  serve({ fetch: createWebApp().fetch, port: PORT }, () => {
    const initData = signInitData(
      { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: ADA, first_name: 'Ada', username: 'ada' }), query_id: 'PREVIEW' },
      config.botToken,
    );
    console.log(`\n🌐 Preview: http://localhost:${PORT}/?initData=${encodeURIComponent(initData)}\n`);
  });

  // Same teardown runScript gives the one-shot scripts (this one lives until
  // Ctrl+C): drop the per-process test schema so preview runs don't accumulate.
  process.on('SIGINT', async () => {
    await dropTestSchema();
    await closePool();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
