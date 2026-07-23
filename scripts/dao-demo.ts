/**
 * DAO-push payout walk, fully offline: the NEAR JSON-RPC is stubbed at
 * globalThis.fetch (the same boundary rooms-demo stubs the AI endpoint), so the
 * service-layer propose → adopt → vote → settle path runs deterministically in
 * the `npm test` gate — the first coverage of the push money path that doesn't
 * need testnet. Covers: typed payout accounts (existence-checked, typo
 * refused), proposePayout's claim surviving a failed TEE submit (the OutLayer
 * stub gateway is permanently down — see the fetch stub),
 * the reconciler adopting a lost proposal_id by description — validated against
 * the pinned receiver AND amount AND native token, so a front-run to another
 * account, a receiver inflating their OWN payout, and a post-restore
 * (amount-mismatched) executed collision are all refused, while a genuinely-
 * executed orphan (exact identity) settles to 'paid' instead of dead-ending —
 * InProgress holding 'proposed', the /forget preflight refusing an open
 * proposal, Approved → 'paid' (+ the dedup-keyed paid DM), Rejected → back to
 * 'pending' (loud, re-proposable), lapsed-window → 'pending' with the link
 * cleared, and Failed → 'proposed' with the attention flag. Also: a dead
 * (expired/rejected) identity match from a prior cycle is never adopted over a
 * fresh claim, and a council-REMOVED proposal (which the contract answers with
 * an ERR_NO_PROPOSAL panic — the stub mirrors that, never a null) re-queues
 * loudly instead of stalling the row and /forget forever. A healed abandoned
 * claim keeps receiver+amount as claim memory, so a failed submit's proposal
 * landing long after the heal is still discovered: /forget blocks on the live
 * late proposal, /pay refuses to double-propose (settling an already-executed
 * one as paid), and reconcile adopts it like any lost id-write. And a
 * destination CHANGE while an old claim is unaccounted for is REFUSED (a
 * bounded wait — migration 016 dropped the watched superseded set the printed
 * command era needed), and claim memory itself EXPIRES past the tx-validity
 * bound, ending the watch.
 */
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// Stub the NEAR RPC at globalThis.fetch. ESM hoists the static imports below
// ABOVE this assignment, so near-kit is imported first — this works because
// near-kit reads globalThis.fetch at CALL time, not at import, and no import
// here performs network I/O at module-init. One in-memory "chain":
// proposals keyed by id, plus the set of accounts that exist. near-kit and
// account.ts both speak standard JSON-RPC `query` — decode, dispatch, encode.
interface ChainProposal {
  id: number;
  proposer: string;
  description: string;
  kind: unknown;
  status: string;
  submission_time: string; // nanoseconds, decimal string
}
const DAY_NS = 24n * 60n * 60n * 1_000_000_000n;
const chain = {
  proposals: new Map<number, ChainProposal>(),
  // Monotonic like the real contract: RemoveProposal DELETES the map entry but
  // never rewinds the id counter — keyed off size, a removal would collide ids.
  nextProposalId: 0,
  accounts: new Set(['fay.testnet', 'fay2.testnet']),
  policy: { proposal_bond: '100000000000000000000000', proposal_period: String(7n * DAY_NS) },
};
function addProposal(description: string, receiver: string, status = 'InProgress', submittedNsAgo = 0n, amount = '1'): number {
  const id = chain.nextProposalId++;
  chain.proposals.set(id, {
    id,
    proposer: 'admin.testnet',
    description,
    kind: { Transfer: { token_id: '', receiver_id: receiver, amount, msg: null } },
    status,
    submission_time: String(BigInt(Date.now()) * 1_000_000n - submittedNsAgo),
  });
  return id;
}
const rpcResult = (value: unknown): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'stub',
      result: { result: Array.from(Buffer.from(JSON.stringify(value))), logs: [], block_height: 1, block_hash: 'h' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
// A contract PANIC on a view — the shape the RPC actually returns (an `error`
// string inside a 200 result; near-kit maps it to a thrown FunctionCallError).
const rpcPanic = (panicMsg: string): Response =>
  new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 'stub',
      result: {
        error: `wasm execution failed with error: FunctionCallError(HostError(GuestPanic { panic_msg: "${panicMsg}" }))`,
        logs: [],
        block_height: 1,
        block_hash: 'h',
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
  // The bot's OutLayer TEE submit (the ONLY proposer path): permanently "down"
  // in this suite — every submit fails AFTER the row is claimed, the
  // deterministic stand-in for a gateway timeout. Proposals "land" only via
  // addProposal(), simulating a failed-response submit that executed anyway
  // (or an out-of-band proposal) — which is exactly what the claim/heal/adopt
  // machinery under test exists to reconcile.
  if (String(url).startsWith('http://outlayer.stub')) {
    return new Response(JSON.stringify({ status: 'error', error: 'stub gateway down' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const req = typeof init?.body === 'string' ? (JSON.parse(init.body) as { params?: Record<string, unknown> }) : {};
  const params = req.params ?? {};
  if (params.request_type === 'view_account') {
    // accountExists (near-kit getAccount): a FULL view_account result for known
    // accounts (near-kit Zod-validates it), and the real handler-error shape for
    // unknown ones (near-kit maps that to AccountDoesNotExistError — a stripped
    // shape falls through as a generic network error).
    return new Response(
      JSON.stringify(
        chain.accounts.has(String(params.account_id))
          ? {
              jsonrpc: '2.0',
              id: 'stub',
              result: { amount: '1', locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182, storage_paid_at: 0, block_height: 1, block_hash: 'h' },
            }
          : {
              jsonrpc: '2.0',
              id: 'stub',
              error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error', data: `account ${String(params.account_id)} does not exist while viewing` },
            },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  const args = JSON.parse(Buffer.from(String(params.args_base64 ?? 'e30='), 'base64').toString()) as Record<string, unknown>;
  switch (params.method_name) {
    case 'get_policy':
      return rpcResult(chain.policy);
    case 'get_last_proposal_id':
      // sputnikdao2 returns the id COUNTER (next id, one past the newest), NOT
      // the newest live id — it never rewinds when a proposal is removed.
      return rpcResult(chain.nextProposalId);
    case 'get_proposals': {
      // Removed ids are silently absent from pages (the real contract filter_maps).
      const from = Number(args.from_index ?? 0);
      const limit = Number(args.limit ?? 100);
      return rpcResult([...chain.proposals.values()].filter((p) => p.id >= from).slice(0, limit));
    }
    case 'get_proposal': {
      // The real contract PANICS on a missing id (`.expect("ERR_NO_PROPOSAL")`) —
      // it never returns null. A REMOVED proposal is deleted from storage, so
      // this panic is also the only way removal ever reads back.
      const proposal = chain.proposals.get(Number(args.id));
      return proposal ? rpcResult(proposal) : rpcPanic('ERR_NO_PROPOSAL');
    }
    default:
      throw new Error(`dao-demo stub: unexpected RPC method ${String(params.method_name)}`);
  }
}) as typeof fetch;

import {
  upsertContributor,
  getContributor,
  forgetContributor,
  setPayoutAccount,
  getPayoutAccount,
  proposePayout,
  reconcilePayout,
  pinnedAmountNear,
  setPayoutPaidNotifier,
  WorkflowError,
  type Payout,
} from '../src/core/service.js';
import { seedPendingPayout } from './seed.js';
import { notifyPayoutPaid } from '../src/bot/notify.js';
import { findByDedup } from '../src/core/models/notification.js';
import { getById } from '../src/core/models/payout.js';
import { payoutDescription } from '../src/near/dao.js';
import { run } from '../src/core/db.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';
import { step, ok } from './harness.js';

// Same wiring as src/index.ts boot: the reconciler DMs the owner when a payout
// lands, so this suite covers the DM firing inside the settlement rule.
setPayoutPaidNotifier(notifyPayoutPaid);

const ADMIN = 1;
const FAY = 600;

/** Approve rewarded work for FAY on a fresh task → one 'pending' payout
 *  (the shared canonical fixture — see scripts/seed.ts). */
const pendingPayout = (title: string): Promise<Payout> =>
  seedPendingPayout({ title, reward: '0.5 NEAR', admin: ADMIN, contributor: FAY });

/** The payout row as it is NOW (reconcilers persist transitions). */
async function row(id: number): Promise<Payout> {
  return (await getById(id))!;
}

/** The on-chain proposal description — the production encoding (the adopt /
 *  recovery key), pinned to its literal format by an assertion in main(). */
function desc(p: Payout): string {
  return payoutDescription(p.id, p.task_id);
}

/** Backdate a payout row `ms` into the past — pushes a claim/pin beyond the
 *  reconciler's grace windows (2h clears the abandoned-claim grace, 10m the
 *  removed-pin hold). */
async function agePayout(id: number, ms: number): Promise<void> {
  await run('UPDATE payouts SET updated_at = $2 WHERE id = $1', [id, new Date(Date.now() - ms).toISOString()]);
}

/** proposePayout against the down stub gateway: the submit fails AFTER the row
 *  is claimed, leaving 'proposed'+null with claim memory — the gateway-timeout
 *  reality every heal/adopt step below builds on. The claim surviving the
 *  failure is itself the contract (a failed response doesn't prove the
 *  proposal didn't land). */
async function proposeClaim(payoutId: number, receiver: string, amount: string): Promise<void> {
  await assert.rejects(
    () => proposePayout(payoutId, receiver, amount),
    (err: unknown) => err instanceof WorkflowError && /OutLayer submit failed/.test(err.message),
    'the stub gateway is down — the submit fails but the claim must be kept',
  );
}

async function main(): Promise<void> {
  // desc() delegates to the production encoding; this pin means a deliberate
  // format change fails HERE (one edit), while accidental drift still fails loudly.
  assert.equal(payoutDescription(7, 9), 'multiagency payout #7 task #9');

  await resetDb();
  await upsertContributor(FAY, 'fay', 'Fay');

  step('typed payout account: existence-checked, typo refused');
  await assert.rejects(
    () => setPayoutAccount(FAY, 'ghost.testnet'),
    (err) => err instanceof WorkflowError && /doesn.t exist/.test(err.message),
    'a nonexistent account is refused before any money can route to it',
  );
  await setPayoutAccount(FAY, 'fay.testnet');
  assert.equal(await getPayoutAccount(FAY), 'fay.testnet');
  ok('ghost account refused; real account saved');

  step('propose: the claim survives a failed TEE submit (proposed-pending)');
  const paidPath = await pendingPayout('Paid path');
  await proposeClaim(paidPath.id, 'fay.testnet', '1');
  let p = await row(paidPath.id);
  assert.equal(p.status, 'proposed');
  assert.equal(p.proposal_id, null, 'no id — the gateway reported failure; the description is the recovery key');
  ok('payout claimed proposed-pending despite the failed submit');

  step('reconciler adopts the on-chain proposal by description');
  const paidProposalId = addProposal(desc(paidPath), 'fay.testnet');
  let rec = await reconcilePayout(await row(paidPath.id));
  assert.equal(rec.status, 'proposed');
  assert.ok(rec.ok && !rec.attention);
  assert.equal(rec.proposalId, paidProposalId, 'reconcile returns the just-adopted id (so /payouts renders it this run, not next)');
  p = await row(paidPath.id);
  assert.equal(p.proposal_id, 0, 'the lost proposal_id was recovered by description match');
  assert.equal(p.account_id, 'fay.testnet', 'the receiver was pinned from the on-chain Transfer');
  ok('adopt-or-create: a retry can never double-propose');

  step('re-propose over an already-pinned live proposal never re-pins (no orphaned double)');
  // A second identical live proposal exists alongside the pinned one (an accidental
  // double add_proposal, or a benign front-run). A re-run must report the EXISTING
  // pin, never re-pin to the newer duplicate — re-pinning would orphan the first,
  // still-approvable proposal (a double-pay). Reuses paidPath, pinned to id 0 above.
  const dupId = addProposal(desc(paidPath), 'fay.testnet', 'InProgress', 0n, '1');
  assert.notEqual(dupId, paidProposalId, 'the duplicate is a distinct, newer live proposal');
  const rePropose = await proposePayout(paidPath.id, 'fay.testnet', '1');
  assert.deepEqual(rePropose, { proposalId: paidProposalId }, 'reports the pinned id, not the newer duplicate');
  assert.equal((await row(paidPath.id)).proposal_id, paidProposalId, 'the row is still pinned to the original — the duplicate was not adopted');
  ok('an already-pinned row is never re-pinned to a newer duplicate');

  step('a live duplicate of the pinned transfer is surfaced, never silent');
  // Not adopting the twin (above) is necessary but not sufficient: with the
  // ledger pinned to one proposal, the identical live twin is invisible to every
  // status — and the council approving BOTH is a double-pay. Reconcile must say so.
  rec = await reconcilePayout(await row(paidPath.id));
  assert.equal(rec.status, 'proposed');
  assert.ok(rec.duplicateProposals, 'the live identical twin is detected (an out-of-band duplicate)');
  assert.ok(!rec.attention, 'its own flag, not attention — attention keeps meaning failed/voted-down');
  ok('duplicate live proposals are named while the council can still refuse one');

  step('an open proposal blocks /forget (money in flight)');
  await assert.rejects(
    () => forgetContributor(FAY, ADMIN),
    (err) => err instanceof WorkflowError && err.message.includes('open DAO payout proposal'),
    'the DAO preflight refuses while the council can still send the money',
  );
  assert.ok(await getContributor(FAY), 'nothing was erased');
  ok('erasure waits for the vote');

  step('council approves → paid; the contributor is DM’d exactly once');
  chain.proposals.get(0)!.status = 'Approved';
  rec = await reconcilePayout(await row(paidPath.id));
  assert.equal(rec.status, 'paid');
  assert.equal((await row(paidPath.id)).status, 'paid');
  // The DM fired inside reconcilePayout (the registered notifier) — no surface
  // re-derives the transition. A second observation (here, a direct call) is
  // dedup-keyed per payout, so it can never double-DM.
  await notifyPayoutPaid(FAY, paidPath.task_id, paidPath.id, 'fay.testnet');
  const dm = await findByDedup(`payout-paid:${paidPath.id}`);
  assert.ok(dm && dm.text?.includes('fay.testnet'), 'one paid DM, naming the receiving account');
  ok('proposed → paid; single dedup-keyed DM');

  step('council rejects → back to pending (re-proposable), never paid, link cleared');
  // Per PAYOUTS.md: by payout time the WORK was already approved in review — the
  // council sanctions only the TRANSFER, so a rejection is operational (wrong
  // amount/account) and must re-queue, not dead-end in a terminal status no
  // admin tool can reopen.
  const rejectedPath = await pendingPayout('Rejected path');
  await proposeClaim(rejectedPath.id, 'fay.testnet', '1');
  const firstId = addProposal(desc(rejectedPath), 'fay.testnet', 'InProgress');
  rec = await reconcilePayout(await row(rejectedPath.id)); // adopts + pins while live
  assert.equal((await row(rejectedPath.id)).proposal_id, firstId, 'live proposal adopted before the vote');
  chain.proposals.get(firstId)!.status = 'Rejected';
  rec = await reconcilePayout(await row(rejectedPath.id));
  assert.equal(rec.status, 'pending');
  assert.equal(rec.attention, true, 'a rejection re-queues LOUDLY, not silently');
  p = await row(rejectedPath.id);
  assert.equal(p.proposal_id, null, 'the dead proposal unlinks so /pay can re-propose');
  assert.equal(p.attention, true, 'WHY it re-queued persists on the row — /payouts flags it until the re-propose');
  // Re-propose after the rejection: adoption is Pending-only + newest-first, so
  // the second proposal is adopted — the rejected corpse can never loop back in.
  await proposeClaim(rejectedPath.id, 'fay.testnet', '1');
  assert.equal((await row(rejectedPath.id)).attention, false, 'the new claim clears the flag — it was acted on');
  const secondId = addProposal(desc(rejectedPath), 'fay.testnet', 'InProgress');
  rec = await reconcilePayout(await row(rejectedPath.id));
  assert.equal(rec.status, 'proposed');
  assert.equal((await row(rejectedPath.id)).proposal_id, secondId, 'adopt matched the new live proposal, not the rejected one');
  // Settle the re-proposed payout so the erasure finale's "all money settled"
  // premise holds (and the second attempt paying is itself worth pinning).
  chain.proposals.get(secondId)!.status = 'Approved';
  rec = await reconcilePayout(await row(rejectedPath.id));
  assert.equal(rec.status, 'paid', 'the corrected re-propose pays');
  ok('rejected vote re-queues loudly; re-propose adopts the new proposal and pays');

  step('voting window lapsed → back to pending, link cleared for a re-propose');
  const expiredPath = await pendingPayout('Expired path');
  await proposeClaim(expiredPath.id, 'fay.testnet', '1');
  // Pin while LIVE, then age it: adoption is Pending-only (an expired proposal
  // is never adopted), so expiry must be observed via the pinned id — the
  // production sequence.
  const expiringId = addProposal(desc(expiredPath), 'fay.testnet', 'InProgress');
  await reconcilePayout(await row(expiredPath.id)); // adopts + pins
  assert.equal((await row(expiredPath.id)).proposal_id, expiringId, 'live proposal pinned before the window lapses');
  chain.proposals.get(expiringId)!.submission_time = String(BigInt(Date.now()) * 1_000_000n - 8n * DAY_NS);
  rec = await reconcilePayout(await row(expiredPath.id));
  assert.equal(rec.status, 'pending');
  p = await row(expiredPath.id);
  assert.equal(p.proposal_id, null, 'reset clears the proposal link');
  assert.equal(p.account_id, null, 'and the receiver — it re-enters the queue afresh');
  ok('lapsed window re-queues the payout');

  step('approved-but-FAILED transfer → holds proposed with the attention flag');
  const stuckPath = await pendingPayout('Stuck path');
  await proposeClaim(stuckPath.id, 'fay.testnet', '1');
  const failedId = addProposal(desc(stuckPath), 'fay.testnet', 'Failed');
  rec = await reconcilePayout(await row(stuckPath.id));
  assert.equal(rec.status, 'proposed');
  assert.ok(rec.ok, 'a Failed status is a successful READ — the flag is the news');
  assert.ok(rec.attention, 'the admin is flagged — treasury balance, re-finalize');
  ok('Failed execution never reads as paid');

  step('adoption is receiver-checked: a front-run to another account is never adopted');
  // The description is public and predictable, so anyone with add_proposal rights
  // can pre-submit our exact description paying THEIR account. Adopting it would
  // redirect the payout AND make the bot vouch for the attacker's proposal id —
  // and submitting our own ALONGSIDE the live front-run would put two live
  // Transfers for one payout in front of the council (approve both = double-pay),
  // so /pay fails closed while it lives, leaving the row untouched.
  const guardedPath = await pendingPayout('Front-run guard');
  chain.accounts.add('attacker.testnet');
  const frontRunId = addProposal(desc(guardedPath), 'attacker.testnet', 'InProgress');
  await assert.rejects(
    () => proposePayout(guardedPath.id, 'fay.testnet', '1'),
    (err) => err instanceof WorkflowError && err.message.includes('pays a different account or amount'),
    'a live mismatched proposal blocks a fresh submit — never adopted, never doubled',
  );
  assert.equal((await row(guardedPath.id)).status, 'pending', 'the refused /pay leaves the row re-payable');
  // The council rejects the front-run → it is no longer live → /pay proceeds.
  chain.proposals.get(frontRunId)!.status = 'Rejected';
  await proposeClaim(guardedPath.id, 'fay.testnet', '1'); // front-run dead → propose proceeds to claim + submit
  await reconcilePayout(await row(guardedPath.id));
  assert.equal((await row(guardedPath.id)).proposal_id, null, 'reconcile never adopts a proposal paying a different account');
  // The real proposal to fay lands → adopted; approve it to settle the row.
  const legitId = addProposal(desc(guardedPath), 'fay.testnet', 'InProgress');
  await reconcilePayout(await row(guardedPath.id));
  assert.equal((await row(guardedPath.id)).proposal_id, legitId, 'the receiver-matching live proposal is the one adopted');
  chain.proposals.get(legitId)!.status = 'Approved';
  await reconcilePayout(await row(guardedPath.id));
  ok('front-run ignored by both propose and reconcile; the real proposal settles');

  step('adoption is amount-checked: a receiver can’t inflate their own payout');
  // The receiver IS the contributor, so checking the account alone isn't enough —
  // they could front-run their own payout with an inflated-amount proposal. The
  // amount proposed by /pay is pinned on the row and re-checked, so the inflated
  // one is refused; only the exact-amount proposal is adopted.
  const inflatePath = await pendingPayout('Inflation guard');
  await proposeClaim(inflatePath.id, 'fay.testnet', '1'); // pins amount_yocto = '1'
  addProposal(desc(inflatePath), 'fay.testnet', 'InProgress', 0n, '999999999'); // self-inflated
  await reconcilePayout(await row(inflatePath.id));
  assert.equal((await row(inflatePath.id)).proposal_id, null, 'an inflated-amount proposal to the right account is refused');
  const rightId = addProposal(desc(inflatePath), 'fay.testnet', 'InProgress', 0n, '1');
  await reconcilePayout(await row(inflatePath.id));
  assert.equal((await row(inflatePath.id)).proposal_id, rightId, 'only the exact-amount proposal is adopted');
  chain.proposals.get(rightId)!.status = 'Approved';
  await reconcilePayout(await row(inflatePath.id)); // settle for the finale
  ok('a receiver cannot inflate their own payout — amount is pinned and checked');

  step('post-restore executed collision (different amount) is never adopted as paid');
  // A DB reset/PITR restarts payout ids while the long-lived DAO keeps old
  // EXECUTED proposals. A description collision whose amount differs must NOT
  // settle a fresh payout 'paid' with no money moved — the amount check refuses
  // it on BOTH the propose (live-only) and the reconcile path.
  const restorePath = await pendingPayout('Restore guard');
  addProposal(desc(restorePath), 'fay.testnet', 'Approved', 0n, '999'); // old, executed, different amount
  await proposeClaim(restorePath.id, 'fay.testnet', '1'); // the stale executed match is not adopted — propose submits its own
  await reconcilePayout(await row(restorePath.id));
  const restoreRow = await row(restorePath.id);
  assert.equal(restoreRow.status, 'proposed');
  assert.equal(restoreRow.proposal_id, null, 'no false paid: the amount-mismatched executed proposal was never pinned');
  ok('post-restore id collision (amount mismatch) never adopts an old executed proposal as paid');

  step('an abandoned claim auto-heals to pending — no manual /unpay');
  // The row above is a 'proposed'+null claim whose (mismatched) proposal isn't
  // adoptable — i.e. an abandoned claim. A YOUNG one is held (its real proposal
  // might still be landing); past the grace, reconcile resets it to 'pending' on
  // its own, so no admin command is needed and nothing stays stuck.
  await reconcilePayout(await row(restorePath.id));
  assert.equal((await row(restorePath.id)).status, 'proposed', 'a young abandoned claim is held, not reset');
  await agePayout(restorePath.id, 2 * 60 * 60 * 1000);
  await reconcilePayout(await row(restorePath.id));
  assert.equal((await row(restorePath.id)).status, 'pending', 'past the grace, the abandoned claim auto-heals to pending');
  ok('abandoned claim self-heals to pending; young claim held meanwhile');

  step('a genuinely-executed orphan (exact identity) settles to paid, not a dead-end');
  // Lost id-write + the proposal executed before any reconcile: the row is
  // proposed+null. Reconcile adopts the executed proposal (exact receiver AND
  // amount = ours) and settles it 'paid' — a blanket "never adopt Executed" rule
  // would have stranded it forever (a manual reset then re-/pay could double-pay).
  const orphanPath = await pendingPayout('Executed orphan');
  await proposeClaim(orphanPath.id, 'fay.testnet', '1'); // proposed+null, amount pinned
  addProposal(desc(orphanPath), 'fay.testnet', 'Approved', 0n, '1'); // executed, exactly ours
  rec = await reconcilePayout(await row(orphanPath.id));
  assert.equal(rec.status, 'paid', 'the executed orphan is adopted by identity and settled, not dead-ended');
  ok('an executed orphan matching receiver+amount settles to paid');

  step('a dead corpse from a prior cycle never collapses a fresh /pay claim');
  // A payout's proposal expires unvoted → reset to pending → the admin re-runs
  // /pay with the SAME amount (the normal move). The dead predecessor carries
  // the IDENTICAL identity (description + receiver + amount), so a reconcile
  // firing mid-submit (a contributor loading the Mini App) must NOT adopt the
  // corpse — that would pin it, read Expired, and reset the fresh claim in one
  // pass: grace bypassed, the real proposal lands orphaned (double-pay shape —
  // and a seen-dead reset wipes the claim memory that keeps late proposals
  // visible to reconcile, /pay, and /forget).
  const corpsePath = await pendingPayout('Corpse guard');
  await proposeClaim(corpsePath.id, 'fay.testnet', '1');
  const corpseId = addProposal(desc(corpsePath), 'fay.testnet', 'InProgress');
  await reconcilePayout(await row(corpsePath.id)); // adopts + pins while live
  chain.proposals.get(corpseId)!.submission_time = String(BigInt(Date.now()) * 1_000_000n - 8n * DAY_NS);
  await reconcilePayout(await row(corpsePath.id)); // expired → reset to pending
  assert.equal((await row(corpsePath.id)).status, 'pending', 'the expired proposal re-queued the payout');
  await proposeClaim(corpsePath.id, 'fay.testnet', '1'); // the re-/pay, same amount — the corpse is not adopted (Pending-only)
  rec = await reconcilePayout(await row(corpsePath.id)); // the mid-submit reconcile
  assert.equal((await row(corpsePath.id)).status, 'proposed', 'the fresh claim survives — the corpse was not adopted');
  assert.ok(!rec.ok && rec.held, 'the young claim is held for its real proposal, not collapsed');
  const freshId = addProposal(desc(corpsePath), 'fay.testnet', 'InProgress');
  await reconcilePayout(await row(corpsePath.id));
  assert.equal((await row(corpsePath.id)).proposal_id, freshId, 'the real (live) proposal is the one adopted');
  chain.proposals.get(freshId)!.status = 'Approved';
  await reconcilePayout(await row(corpsePath.id)); // settle for the finale
  ok('dead identity match ignored; the fresh claim held for its own proposal');

  step('council RemoveProposal → re-queued loudly, never a permanent stall');
  // Sputnik DELETES a removed proposal, so get_proposal PANICS (ERR_NO_PROPOSAL)
  // forever after — the `Removed` status literal never reads back. A pinned row
  // must re-queue off that panic (attention on: the bond was kept, a human
  // should look), not stall 'proposed' for good — that would also brick /forget.
  // Belt against a lagging RPC node: a fresh pin is HELD, believed removed only
  // once the id counter is past it and the pin has aged.
  const removedPath = await pendingPayout('Removed path');
  await proposeClaim(removedPath.id, 'fay.testnet', '1');
  const removedId = addProposal(desc(removedPath), 'fay.testnet', 'InProgress');
  await reconcilePayout(await row(removedPath.id)); // adopts + pins while live
  assert.equal((await row(removedPath.id)).proposal_id, removedId);
  chain.proposals.delete(removedId); // the council's RemoveProposal
  rec = await reconcilePayout(await row(removedPath.id));
  assert.ok(!rec.ok, 'a freshly-pinned "no such proposal" is held (lagging-node belt), not yet believed');
  assert.equal((await row(removedPath.id)).status, 'proposed', 'the young pin is untouched');
  await agePayout(removedPath.id, 10 * 60 * 1000);
  rec = await reconcilePayout(await row(removedPath.id));
  assert.equal(rec.status, 'pending');
  assert.equal(rec.attention, true, 'removal re-queues LOUDLY, like a rejection');
  p = await row(removedPath.id);
  assert.equal(p.proposal_id, null, 'the deleted proposal unlinks so /pay can re-propose');
  assert.equal(p.attention, true, 'the row carries WHY it re-queued');
  ok('removed proposal re-queues with attention; no permanent stall, /forget stays reachable');

  step('a healed claim keeps its memory — a late-landing proposal is never invisible');
  // A gateway-reported-failed submit can still execute; its proposal can surface
  // HOURS after the claim healed back to 'pending'. The heal keeps receiver+amount
  // as claim memory, so the late proposal is (a) discovered by /forget's preflight
  // (erasure can't slip past an approvable Transfer), (b) refused by a re-/pay
  // (no second Transfer for one payout), and (c) adopted + settled normally.
  const latePath = await pendingPayout('Late landing');
  await proposeClaim(latePath.id, 'fay.testnet', '1'); // failed submit: proposed+null
  await agePayout(latePath.id, 2 * 60 * 60 * 1000);
  await reconcilePayout(await row(latePath.id)); // past the grace → auto-heal
  p = await row(latePath.id);
  assert.equal(p.status, 'pending', 'the abandoned claim healed');
  assert.equal(p.account_id, 'fay.testnet', 'but the claimed receiver is KEPT as claim memory');
  assert.equal(p.amount_yocto, '1', 'and the claimed amount — the identity a late proposal must match');
  const lateId = addProposal(desc(latePath), 'fay.testnet', 'InProgress', 0n, '1');
  await assert.rejects(
    () => forgetContributor(FAY, ADMIN),
    (err) => err instanceof WorkflowError && err.message.includes('open DAO payout proposal'),
    'the preflight chain-checks the healed claim and finds the live late proposal',
  );
  assert.equal((await row(latePath.id)).proposal_id, lateId, 'the guard’s reconcile adopted + pinned it');
  const rePay = await proposePayout(latePath.id, 'fay.testnet', '1');
  assert.deepEqual(rePay, { proposalId: lateId }, 'a re-/pay reports the adopted proposal — never a second Transfer');
  chain.proposals.get(lateId)!.status = 'Approved';
  rec = await reconcilePayout(await row(latePath.id));
  assert.equal(rec.status, 'paid', 'the late proposal settles the payout exactly once');
  ok('healed claim watched: /forget blocked, re-/pay refused, late proposal adopted and paid');

  step('a late proposal already EXECUTED settles via claim memory — /pay refuses a double-pay');
  // Worse ordering: the failed submit's proposal lands AND the council approves
  // before any surface reconciles. The row still says 'pending'; a /pay — even with a
  // DIFFERENT amount, so only the claim memory can match — must discover the
  // executed Transfer and settle, never submit a second one.
  const lateExecPath = await pendingPayout('Late executed');
  await proposeClaim(lateExecPath.id, 'fay.testnet', '1');
  await agePayout(lateExecPath.id, 2 * 60 * 60 * 1000);
  await reconcilePayout(await row(lateExecPath.id)); // heal, memory kept
  assert.equal((await row(lateExecPath.id)).status, 'pending');
  addProposal(desc(lateExecPath), 'fay.testnet', 'Approved', 0n, '1');
  await assert.rejects(
    () => proposePayout(lateExecPath.id, 'fay.testnet', '2'),
    (err) => err instanceof WorkflowError && err.message.includes('already paid'),
    'the memory identity (not the new request) matches the executed Transfer',
  );
  p = await row(lateExecPath.id);
  assert.equal(p.status, 'paid', 'settled off the chain truth — the money moved exactly once');
  assert.ok(await findByDedup(`payout-paid:${lateExecPath.id}`), 'the paid DM fired from the settle');
  ok('an executed late proposal settles to paid; /pay reports it instead of re-proposing');

  step('destination change is REFUSED while an earlier claim is unresolved');
  // The watched superseded set (migration 015) used to track the old identity so
  // a destination change never dead-ended — priced for a printed CLI command
  // that could land a Transfer forever. With the bot as SINGLE proposer, an
  // unresolved claim is bounded by tx validity, so /pay now simply refuses to
  // switch identities until the earlier claim lands, settles, or its memory
  // expires (migration 016 dropped the set). A bounded wait beats a second
  // identity to track — and a same-identity re-/pay still proceeds (the corpse
  // and late-landing steps above).
  const switchPath = await pendingPayout('Destination switch');
  await proposeClaim(switchPath.id, 'fay.testnet', '1'); // failed submit, memory {fay,1}
  await agePayout(switchPath.id, 2 * 60 * 60 * 1000);
  await reconcilePayout(await row(switchPath.id)); // heal — memory {fay,1} kept
  await setPayoutAccount(FAY, 'fay2.testnet'); // contributor corrects their account
  await assert.rejects(
    () => proposePayout(switchPath.id, 'fay2.testnet', '1'),
    (err) => err instanceof WorkflowError && /earlier claim/.test(err.message),
    'the identity switch waits out the unresolved claim instead of tracking two identities',
  );
  assert.equal((await row(switchPath.id)).account_id, 'fay.testnet', 'the refusal left the earlier claim untouched');
  // The earlier claim's proposal finally lands → adopted, approved → paid.
  // Nothing was lost to the refusal; the money went where the claim said.
  const lateSwitchId = addProposal(desc(switchPath), 'fay.testnet', 'InProgress', 0n, '1');
  rec = await reconcilePayout(await row(switchPath.id));
  assert.equal((await row(switchPath.id)).proposal_id, lateSwitchId, 'the unresolved claim was adopted when it landed');
  chain.proposals.get(lateSwitchId)!.status = 'Approved';
  rec = await reconcilePayout(await row(switchPath.id));
  assert.equal(rec.status, 'paid', 'the earlier claim settled the payout');
  ok('identity switch refused while unresolved; the late-landing claim still settles cleanly');

  step('claim memory EXPIRES past the tx-validity bound — the switch then proceeds');
  // A signed NEAR tx embeds a recent block hash and is includable for
  // transaction_validity_period blocks (~a day at worst); CLAIM_MEMORY_TTL_MS
  // (48h) covers that 2x. Past it, a COMPLETE scan finding nothing proves the
  // failed submit is dead: the memory clears, the row is a plain pending row
  // again (no more per-reconcile window scans), and a destination change
  // unblocks.
  const expirePath = await pendingPayout('Memory expiry');
  await proposeClaim(expirePath.id, 'fay.testnet', '1');
  await agePayout(expirePath.id, 2 * 60 * 60 * 1000);
  await reconcilePayout(await row(expirePath.id)); // heal — memory kept, still watched
  assert.equal((await row(expirePath.id)).account_id, 'fay.testnet', 'memory watched inside the bound');
  await agePayout(expirePath.id, 49 * 60 * 60 * 1000); // past CLAIM_MEMORY_TTL_MS
  rec = await reconcilePayout(await row(expirePath.id));
  assert.equal(rec.status, 'pending');
  p = await row(expirePath.id);
  assert.equal(p.account_id, null, 'expired memory cleared — the claim is chain-provably dead');
  assert.equal(p.amount_yocto, null, 'amount cleared with it');
  await proposeClaim(expirePath.id, 'fay2.testnet', '1'); // the switch now proceeds (fresh claim to fay2)
  assert.equal((await row(expirePath.id)).account_id, 'fay2.testnet', 'the destination change unblocked');
  const expireLandId = addProposal(desc(expirePath), 'fay2.testnet', 'Approved', 0n, '1');
  rec = await reconcilePayout(await row(expirePath.id));
  assert.equal(rec.status, 'paid', 'the new claim settles');
  assert.equal((await row(expirePath.id)).proposal_id, expireLandId);
  await setPayoutAccount(FAY, 'fay.testnet'); // restore for the erasure finale
  ok('claim memory is time-bounded; expiry ends the watching and unblocks the switch');


  step('all money settled → erasure proceeds');
  // Settle every still-open FAY proposal: the re-proposed rejected one, and the
  // stuck (re-finalized) one. Re-queued/pending rows don't block (nothing on-chain).
  chain.proposals.get(secondId)!.status = 'Approved';
  await reconcilePayout(await row(rejectedPath.id));
  chain.proposals.get(failedId)!.status = 'Approved';
  await reconcilePayout(await row(stuckPath.id));
  // One hazard remains, and it hides on a PAID row: paidPath's executed
  // transfer still has its live duplicate twin (dupId) before the council — one
  // approval from paying the same person again with the ledger row erased.
  // /forget's paid-row audit must refuse until the council kills the twin.
  await assert.rejects(
    () => forgetContributor(FAY, ADMIN),
    (err) => err instanceof WorkflowError && /DUPLICATE proposal/.test(err.message),
    'a live duplicate of an executed transfer blocks erasure',
  );
  chain.proposals.get(dupId)!.status = 'Rejected';
  // restorePath healed to 'pending' KEEPING claim memory (its own proposal
  // never landed — only the amount-mismatched collision exists on-chain), and
  // unexpired memory now blocks erasure unconditionally. Its claim is
  // genuinely dead, so age it past the TTL and let reconcile prove that.
  await agePayout(restorePath.id, 49 * 60 * 60 * 1000);
  await reconcilePayout(await row(restorePath.id));
  // Claim memory inside its watch window blocks erasure UNCONDITIONALLY (the
  // same ≤48h bound /pay waits out — see assertNoConflictingClaim): a fresh
  // failed-submit claim heals with memory, /forget refuses until the memory
  // expires, then proceeds.
  const memPath = await pendingPayout('Erasure-vs-memory');
  await proposeClaim(memPath.id, 'fay.testnet', '1');
  await agePayout(memPath.id, 2 * 60 * 60 * 1000);
  await reconcilePayout(await row(memPath.id)); // heal — memory kept, inside TTL
  await assert.rejects(
    () => forgetContributor(FAY, ADMIN),
    (err) => err instanceof WorkflowError && /could still land/.test(err.message),
    'unexpired claim memory blocks erasure — consistent with /pay',
  );
  await agePayout(memPath.id, 49 * 60 * 60 * 1000);
  await reconcilePayout(await row(memPath.id)); // expiry clears the memory
  await forgetContributor(FAY, ADMIN);
  assert.equal(await getContributor(FAY), undefined, 'settled + unstarted money no longer blocks erasure');
  // The zero-row payout-account write after erasure must FAIL, not report
  // "saved" for an account that was never stored (the web handler upserts
  // first, but a /forget can commit between its upsert and this write).
  await assert.rejects(
    () => setPayoutAccount(FAY, 'fay.testnet'),
    (err) => err instanceof WorkflowError && /erased/.test(err.message),
    'setting a payout account for an erased contributor fails honestly',
  );
  ok('erasure completed once nothing was in flight');

  console.log('\n✅ DAO DEMO PASSED — propose → adopt → vote → settle, erasure guard, paid DM (RPC stubbed).');
}

runScript(main);
