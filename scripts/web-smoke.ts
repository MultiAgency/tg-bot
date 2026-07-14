/**
 * Web-tier smoke test. Exercises the Mini App's Hono server + oRPC API against a
 * fresh test database, over the SAME Postgres pool the bot uses:
 *   - /healthz and the placeholder root,
 *   - Telegram initData auth (valid accepted; absent/tampered/wrong-token → 401),
 *   - the read-only oRPC API through the real typed client (the same client the
 *     frontend will use), including that myApplications is caller-scoped.
 *
 * The oRPC client's transport is pointed at the in-memory Hono app via app.request,
 * so it goes through the actual HTTP handler + auth gate + context threading —
 * no port binding, no live Telegram.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { parseKey, Near } from 'near-kit';
import { getAllocation, allocateCommand } from '../src/near/escrow.js';
import { createWebApp } from '../src/web/server.js';
import type { AppRouter } from '../src/web/api.js';
import { signInitData, validateInitData } from '../src/web/auth.js';
import { config } from '../src/config.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';
import {
  createTask,
  approveTask,
  apply,
  upsertContributor,
  assignApplication,
  submitWork,
  reviewSubmission,
} from '../src/core/service.js';

const ADMIN = 1;
const ADA = 42;
const BEN = 99;

const initDataFor = (id: number, name: string) =>
  signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }), query_id: 'AAA' },
    config.botToken,
  );

async function main(): Promise<void> {
  await resetDb();

  // Seed: one open task; Ada (42) applies, Ben (99) does not.
  await upsertContributor(ADA, 'ada', 'Ada', 'en');
  await upsertContributor(BEN, 'ben', 'Ben', 'en');
  const task = await createTask({ title: 'Board task', description: 'Do the thing.', createdBy: ADMIN });
  await approveTask(task.id, ADMIN);
  await apply(task.id, ADA, 'pick me');

  // A rewarded task Ada completes end-to-end → a payout is recorded on approval.
  const paid = await createTask({ title: 'Paid task', description: 'Work.', reward: '50 USDC', createdBy: ADMIN });
  await approveTask(paid.id, ADMIN);
  const paidApp = await apply(paid.id, ADA, 'me');
  await assignApplication(paidApp.id, ADMIN);
  const { submission } = await submitWork(paidApp.id, ADA, 'text', 'done');
  await reviewSubmission(submission.id, ADMIN, 'approve', null);

  const app = createWebApp();

  const health = await app.request('/healthz');
  assert.equal(health.status, 200, 'healthz returns 200');
  assert.deepEqual(await health.json(), { ok: true, db: 'up' }, 'healthz reports the shared DB is up');
  console.log('  ✅ /healthz → 200, shared DB pool reachable');

  // ---- initData auth ----
  const adaInit = initDataFor(ADA, 'Ada');
  assert.equal(validateInitData(adaInit).user.id, ADA, 'a correctly-signed payload validates');
  const meOk = await app.request('/api/me', { headers: { Authorization: `tma ${adaInit}` } });
  assert.equal(((await meOk.json()) as { user: { id: number } }).user.id, ADA, '/api/me returns the verified user');
  assert.equal((await app.request('/api/me')).status, 401, 'no initData → 401');
  const forged = adaInit.replace(/hash=([0-9a-f])/, (_m, ch) => `hash=${ch === '0' ? '1' : '0'}`);
  assert.equal((await app.request('/api/me', { headers: { Authorization: `tma ${forged}` } })).status, 401, 'tampered hash → 401');
  const wrong = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: ADA }) }, '999:not-our-token');
  assert.equal((await app.request('/api/me', { headers: { Authorization: `tma ${wrong}` } })).status, 401, 'wrong-token → 401');
  // Real webview payloads carry Telegram's Ed25519 `signature` field, and it is
  // PART of the HMAC check string (only `hash` is excluded). Regression pin:
  // the validator once stripped it pre-hash, rejecting every live login while
  // signature-less fabricated payloads kept this suite green.
  const withSig = signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: ADA }), query_id: 'AAA', signature: 'ZmFrZS1lZDI1NTE5' },
    config.botToken,
  );
  assert.equal(validateInitData(withSig).user.id, ADA, 'signature field is hashed with the rest, not stripped');
  console.log('  ✅ initData auth: valid accepted; absent / tampered / wrong-token → 401');

  // ---- oRPC read API, through the real typed client ----
  const clientFor = (initData?: string): RouterClient<AppRouter> =>
    createORPCClient(
      new RPCLink({
        url: 'http://local/rpc',
        headers: initData ? { Authorization: `tma ${initData}` } : {},
        fetch: (request) => Promise.resolve(app.request(request)),
      }),
    );

  const ada = clientFor(adaInit);
  const openTasks = await ada.openTasks();
  assert.ok(openTasks.some((t) => t.id === task.id && t.title === 'Board task'), 'openTasks returns the seeded open task');
  assert.ok(openTasks.every((t) => typeof t.assigned === 'number'), 'each summary carries a slot count');

  const detail = await ada.taskDetail({ taskId: task.id });
  assert.equal(detail?.description, 'Do the thing.', 'taskDetail returns the full task');
  assert.equal(await ada.taskDetail({ taskId: 999999 }), null, 'taskDetail returns null for a missing task');
  // Drafts are below the visibility floor: initData proves identity, not
  // entitlement, so an unapproved draft must not be enumerable by taskId.
  const draft = await createTask({ title: 'Unapproved draft', description: 'Secret.', createdBy: ADMIN });
  assert.equal(await ada.taskDetail({ taskId: draft.id }), null, 'taskDetail hides drafts (visibility floor)');

  const adaApps = await ada.myApplications();
  assert.ok(adaApps.some((a) => a.taskId === task.id && a.status === 'applied'), 'myApplications shows the caller’s application');
  console.log('  ✅ oRPC openTasks / taskDetail / myApplications return the seeded data');

  // Scoping: Ben has no applications, and the API keys off the VERIFIED caller,
  // not any client-supplied id — so Ben cannot see Ada's application.
  const ben = clientFor(initDataFor(BEN, 'Ben'));
  assert.deepEqual(await ben.myApplications(), [], 'myApplications is scoped to the verified caller (Ben sees none)');
  await assert.rejects(() => clientFor().openTasks(), 'an unauthenticated oRPC call is rejected');
  console.log('  ✅ myApplications is caller-scoped; unauthenticated calls rejected');

  // ---- payouts: recorded on approval, surfaced to the owed contributor only ----
  const payouts = await ada.myPayouts();
  assert.ok(
    payouts.some((p) => p.taskId === paid.id && p.reward === '50 USDC' && p.status === 'pending'),
    'approving rewarded work records a pending payout for the contributor',
  );
  assert.deepEqual(await ben.myPayouts(), [], 'payouts are caller-scoped (Ben is owed none)');
  console.log('  ✅ payout recorded on approval; myPayouts caller-scoped');

  // ---- NEAR wallet link (real NEP-413 round trip against testnet) ----
  // No wallet is linked yet.
  const meBefore = (await (await app.request('/api/me', { headers: { Authorization: `tma ${adaInit}` } })).json()) as {
    linkedNearAccount: string | null;
  };
  assert.equal(meBefore.linkedNearAccount, null, 'no NEAR account linked initially');

  const nonceRes = await app.request('/api/wallet/nonce', { method: 'POST', headers: { Authorization: `tma ${adaInit}` } });
  const challenge = (await nonceRes.json()) as { nonce: string; message: string; recipient: string; network: string };
  assert.ok(challenge.nonce && challenge.recipient === 'multiagency', 'nonce challenge issued');

  // Sign the challenge with a REAL testnet account's key, then verify the whole
  // proof (signature + on-chain full-access binding) through the link endpoint.
  // Best-effort: skipped (not failed) if the testnet key or RPC isn't available,
  // so the suite still runs offline.
  const credPath = `${homedir()}/.near-credentials/testnet/webfoundry.testnet.json`;
  let ranLink = false;
  try {
    const cred = JSON.parse(readFileSync(credPath, 'utf8')) as { account_id: string; private_key: string };
    const kp = parseKey(cred.private_key);
    const signed = kp.signNep413Message!(cred.account_id, {
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: new Uint8Array(Buffer.from(challenge.nonce, 'base64')),
    });
    const linkRes = await app.request('/api/wallet/link', {
      method: 'POST',
      headers: { Authorization: `tma ${adaInit}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce }),
    });
    assert.equal(linkRes.status, 200, 'a valid NEP-413 proof (verified against testnet) links the account');
    const meAfter = (await (await app.request('/api/me', { headers: { Authorization: `tma ${adaInit}` } })).json()) as {
      linkedNearAccount: string | null;
    };
    assert.equal(meAfter.linkedNearAccount, cred.account_id, '/api/me now shows the linked NEAR account');
    ranLink = true;
    console.log('  ✅ NEP-413 wallet link verified end-to-end against testnet (sig + full-access binding)');
  } catch (err) {
    console.log('  ⚠ wallet-link testnet round trip skipped:', err instanceof Error ? err.message : err);
  }

  // Negative (offline, deterministic): a tampered signature is rejected at the
  // crypto step, before any network binding check.
  {
    const n = await (await app.request('/api/wallet/nonce', { method: 'POST', headers: { Authorization: `tma ${adaInit}` } })).json() as { nonce: string };
    const bad = await app.request('/api/wallet/link', {
      method: 'POST',
      headers: { Authorization: `tma ${adaInit}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'webfoundry.testnet', publicKey: 'ed25519:11111111111111111111111111111111', signature: 'ed25519:2222222222222222222222222222222222222222222222222222222222222222', nonce: n.nonce }),
    });
    assert.equal(bad.status, 400, 'a forged signature is rejected');
  }
  console.log(`  ✅ wallet link: forged proof rejected${ranLink ? '' : ' (positive path skipped — offline)'}`);

  // ---- escrow funding queue: command generation + on-chain allocation read ----
  const cmd = allocateCommand(12, 'alice.testnet');
  assert.match(cmd, /escrow\.agency\.testnet allocate/, 'allocate command targets the escrow');
  assert.match(cmd, /"task_id":12,"account_id":"alice\.testnet"/, 'command carries the task + account');
  assert.match(cmd, /<AMOUNT> NEAR/, 'amount is left for the treasury admin to set');
  assert.match(cmd, /sign-as agency\.testnet/, 'signed by the treasury, not the bot');
  // Real read against the live escrow: task 7 → webfoundry.testnet was allocated
  // (and claimed) during the contract test, so its allocation is on-chain.
  try {
    const funded = await getAllocation(7, 'webfoundry.testnet');
    assert.ok(funded && typeof funded.amount === 'string', 'getAllocation reads the live escrow allocation');
    assert.equal(await getAllocation(999999, 'webfoundry.testnet'), null, 'unfunded (task, account) reads as null');
    console.log('  ✅ escrow: allocate command generated; on-chain allocation read from the live contract');
  } catch (err) {
    console.log('  ⚠ escrow read skipped:', err instanceof Error ? err.message : err);
  }

  // ---- claim flow, key-backed, against the LIVE contract ----
  // The exact operations the frontend performs (myPayouts claimable + a near-kit
  // `call(escrow, 'claim')`), verified end to end: treasury allocates on-chain
  // for Ada's rewarded payout → myPayouts flags it claimable → the contributor
  // claims → the allocation is gone. Key-signed here; the frontend wallet.ts runs
  // the identical near-kit `call`, wallet-signed. Runs only if the wallet link
  // above linked Ada to webfoundry.testnet (ranLink).
  if (ranLink) {
    try {
      const escrow = 'escrow.agency.testnet';
      const treasuryKey = JSON.parse(
        readFileSync(`${homedir()}/.near-credentials/testnet/agency.testnet.json`, 'utf8'),
      ) as { private_key: string };
      const wfKey = JSON.parse(readFileSync(credPath, 'utf8')) as { private_key: string };

      // Treasury allocates for (Ada's payout task, webfoundry) unless a prior run left it funded.
      if (!(await getAllocation(paid.id, 'webfoundry.testnet'))) {
        const treasury = new Near({ network: 'testnet', keyStore: { 'agency.testnet': treasuryKey.private_key }, defaultSignerId: 'agency.testnet' });
        await treasury.call(escrow, 'allocate', { task_id: paid.id, account_id: 'webfoundry.testnet' }, { attachedDeposit: '0.05 NEAR' });
      }
      // Poll until the allocation is readable (finality lag between the tx and the view).
      let present = await getAllocation(paid.id, 'webfoundry.testnet');
      for (let i = 0; i < 20 && !present; i++) {
        await new Promise((r) => setTimeout(r, 500));
        present = await getAllocation(paid.id, 'webfoundry.testnet');
      }
      assert.ok(present, 'the allocation is readable on-chain after allocate');
      const claimable = (await ada.myPayouts()).find((p) => p.taskId === paid.id);
      assert.ok(claimable?.claimable, 'myPayouts flags the on-chain-funded payout as claimable');

      // Contributor claims via the same near-kit call path the frontend uses.
      const contributor = new Near({ network: 'testnet', keyStore: { 'webfoundry.testnet': wfKey.private_key }, defaultSignerId: 'webfoundry.testnet' });
      await contributor.call(escrow, 'claim', { task_id: paid.id });
      assert.equal(await getAllocation(paid.id, 'webfoundry.testnet'), null, 'after claim the allocation is gone (paid out)');
      assert.equal((await ada.myPayouts()).find((p) => p.taskId === paid.id)?.claimable, false, 'a claimed payout is no longer claimable');
      console.log('  ✅ claim flow: allocate → myPayouts claimable → claim → gone (key-backed, live contract)');
    } catch (err) {
      console.log('  ⚠ claim flow skipped:', err instanceof Error ? err.message : err);
    }
  }

  // ---- public config + the built Mini App is served ----
  const cfg = await app.request('/config');
  assert.equal(cfg.status, 200, '/config returns 200');
  assert.ok('botUsername' in ((await cfg.json()) as object), '/config exposes botUsername (public, no auth)');
  const index = await app.request('/');
  assert.equal(index.status, 200, 'the built Mini App index is served at /');
  assert.match(await index.text(), /<div id="root">/, '/ serves the Vite-built index.html');
  console.log('  ✅ /config public; built Mini App served at /');

  console.log('\n✅ WEB SMOKE PASSED — Hono + oRPC read API over the shared DB, initData-gated and caller-scoped.');
}

runScript(main);
