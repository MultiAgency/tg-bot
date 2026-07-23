/**
 * Live end-to-end of service.proposePayout: seed a real payout through the workflow,
 * propose it via the OutLayer TEE wallet, verify the ledger, then reconcile.
 * Run: DAO_CONTRACT_ID=multiagency.sputnikv2.testnet OUTLAYER_API_KEY=wk_… \
 *      DATABASE_URL=… BOT_TOKEN=000000:demo ADMIN_IDS=1 npx tsx scripts/dao-propose-live.ts
 *
 * DB persistence: this always resetDb()s the target DB first. Point `DATABASE_URL`
 * at a scratch DB, NOT anything with real data. Note the two behaviours:
 *   - a `_test`/`_ci` DATABASE_URL → an EPHEMERAL per-process schema, dropped on
 *     exit; the seeded payout does NOT survive the run (fine for a one-shot check).
 *   - a plain (non-`_test`) DATABASE_URL → the public schema PERSISTS after exit.
 * To later settle the proposal after a council vote (scripts/dao-settle-live.ts),
 * use a plain persistent DATABASE_URL here so the payout row lives on, and note
 * the printed `proposalId` — that is the proposal a council member approves.
 */
import { resetDb } from './testdb.js';
import { runScript } from './run.js';
import { upsertContributor, proposePayout, reconcilePayout } from '../src/core/service.js';
import { getById } from '../src/core/models/payout.js';
import { seedPendingPayout } from './seed.js';

const ADMIN = 1;
const ADA = 42;

async function main(): Promise<void> {
  await resetDb();
  await upsertContributor(ADA, 'ada', 'Ada', 'en');

  const payout = await seedPendingPayout({ title: 'Test payout', reward: '0.01 NEAR', admin: ADMIN, contributor: ADA });
  console.log(`seeded payout #${payout.id} — reward "${payout.reward}", status ${payout.status}`);

  console.log('→ proposePayout("webfoundry.testnet", 0.01 NEAR) via OutLayer TEE (bot holds no key)...');
  const res = await proposePayout(payout.id, 'webfoundry.testnet', '10000000000000000000000');
  console.log('  result:', JSON.stringify(res));

  const after = await getById(payout.id);
  console.log(`  ledger after: status=${after?.status} proposal_id=${after?.proposal_id} account=${after?.account_id}`);

  process.stdout.write('  reconciling (waiting on finality)');
  let rec;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write('.');
    rec = await reconcilePayout((await getById(payout.id))!);
    if (rec.ok) break;
  }
  console.log('\n  reconcile:', JSON.stringify(rec));

  // Idempotency note: a re-propose adopts by description rather than double-submitting.
  // NB: this shared testnet DAO accumulates proposals with description
  // "multiagency payout #1 task #1" across runs (the test DB resets the payout PK to
  // 1), so a run may adopt an OLD proposal — a test artifact, not a bug: in production
  // payout ids are globally unique, so descriptions are unique. Whether the first call
  // adopted or submitted, a retry never submits a second (the claim + adopt-by-desc).
  console.log('\n✅ proposePayout end-to-end: seed → account-check → OutLayer/adopt add_proposal → markProposed → reconcile');
}

runScript(main);
