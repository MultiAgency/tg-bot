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
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
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
  assert.ok(
    (health.headers.get('content-security-policy') ?? '').includes("script-src 'self' https://telegram.org"),
    'CSP header set (self + the telegram.org bridge only)',
  );
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
  // Freshness: a correctly-signed payload is a bearer credential only within
  // the replay window (1h) — pin the expiry branch via the injectable clock.
  const hourAndABit = 3_700_000;
  assert.throws(
    () => validateInitData(adaInit, config.botToken, undefined, Date.now() + hourAndABit),
    /expired/,
    'a validly-signed but stale initData is rejected',
  );
  assert.equal(validateInitData(adaInit, config.botToken, undefined, Date.now() + 60_000).user.id, ADA, 'fresh initData still validates near the boundary');
  console.log('  ✅ initData auth: valid accepted; absent / tampered / wrong-token / stale → 401');

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
  const paidRow = payouts.find((p) => p.taskId === paid.id);
  assert.ok(
    paidRow?.reward === '50 USDC' && paidRow.status === 'pending',
    'approving rewarded work records a pending payout for the contributor',
  );
  // The exact on-chain amount is null until /pay pins it — the UI surfaces this
  // (not the free-text reward) once proposed/paid, so it must flow through here.
  assert.equal(paidRow?.amountNear, null, 'a pending payout exposes amountNear = null');
  // The verification-honesty fields: a never-claimed pending row costs no chain
  // read, so it is verified-by-construction — ok true, held false. (The !ok and
  // held render branches need a live/rpc-failing DAO and stay untestable here.)
  assert.equal(paidRow?.ok, true, 'a never-claimed pending row reads verified (ok)');
  assert.equal(paidRow?.held, false, 'and not held');
  assert.deepEqual(await ben.myPayouts(), [], 'payouts are caller-scoped (Ben is owed none)');
  console.log('  ✅ payout recorded on approval; myPayouts caller-scoped');

  // ---- payout account: the ONLY web WRITE endpoint — auth-gated + validated ----
  // No successful-set assertion here: setPayoutAccount's on-chain existence check
  // is a live-NEAR path kept out of the deterministic gate. These pin the parts
  // that must never regress silently — auth scope, the required-field 400, and the
  // WorkflowError→400 mapping for a malformed account id (rejected before any RPC).
  const postAccount = (initData: string | undefined, body: unknown) =>
    app.request('/api/payout-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(initData ? { Authorization: `tma ${initData}` } : {}) },
      body: JSON.stringify(body),
    });
  assert.equal((await postAccount(undefined, { account: 'ada.testnet' })).status, 401, 'payout-account write requires initData');
  assert.equal((await postAccount(adaInit, {})).status, 400, 'missing account → 400 (account required)');
  assert.equal(
    (await postAccount(adaInit, { account: 'NOT a valid *acct*' })).status,
    400,
    'a malformed NEAR account id is rejected 400 before any on-chain check',
  );
  // The one write endpoint buffers its body in the bot's process — the 1 KB
  // bodyLimit is what keeps an authenticated-but-anyone giant POST from being
  // a memory lever. Any honest payload (a ≤64-char account) is far under it.
  assert.equal(
    (await postAccount(adaInit, { account: 'x'.repeat(4096) })).status,
    413,
    'an oversized body is refused (413) before it is buffered',
  );
  // The /rpc routes buffer their bodies the same way (oRPC reads the whole
  // request before any zod schema runs) — same lever, same cap.
  assert.equal(
    (
      await app.request('/rpc/openTasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `tma ${adaInit}` },
        body: JSON.stringify({ junk: 'x'.repeat(64 * 1024) }),
      })
    ).status,
    413,
    'an oversized /rpc body is refused (413) before oRPC buffers it',
  );
  const meBody = (await (await app.request('/api/me', { headers: { Authorization: `tma ${adaInit}` } })).json()) as {
    payoutAccount: string | null;
  };
  assert.equal(meBody.payoutAccount, null, '/api/me exposes the caller’s payoutAccount (null before any set)');
  console.log('  ✅ /api/payout-account: initData-gated, account-required + format-validated');

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
