import { one, many, run, nowIso } from '../db.js';

/**
 * A payout owed to a contributor for approved work (see migrations 005 + 010 + 011).
 * The row is the app-side ledger, settled through the DAO-PUSH model (PAYOUTS.md). Status:
 *   pending    — recorded on approval (or re-queued after a rejected/expired
 *                proposal), no live settlement in flight
 *   proposed   — a Sputnik `Transfer` proposal is open (proposal_id pinned);
 *                its InProgress window gates payment, account_id = the receiver
 *   paid       — the proposal was approved and executed (terminal)
 * A rejected or expired proposal returns the payout to `pending` (loud, re-proposable),
 * NOT a terminal state — the council only sanctions the transfer, and the underlying
 * work was already approved (see proposalToPayout / the /forget-vs-money guard).
 */
export const PAYOUT_STATUSES = ['pending', 'proposed', 'paid'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export interface Payout {
  id: number;
  task_id: number;
  contributor_id: number;
  submission_id: number;
  reward: string;
  status: PayoutStatus;
  /** The NEAR account money goes to — the `Transfer` receiver pinned at propose
   *  time. Null while pending UNLESS the row is a healed abandoned claim: the
   *  heal keeps the claimed receiver/amount as CLAIM MEMORY, because a submit
   *  the gateway reported failed can still land on-chain after the heal, and
   *  reconcile must recognize it. Bounded: a signed NEAR tx is only includable
   *  for ~a day, so once a complete scan finds nothing past CLAIM_MEMORY_TTL_MS
   *  reconcile clears the memory (see reconcilePayout; a reset from a proposal
   *  seen DEAD on-chain clears it immediately instead). */
  account_id: string | null;
  /** The yoctoNEAR amount proposed, pinned at propose time; null while pending
   *  except for a healed claim's memory (see account_id above).
   *  Reconciliation checks a candidate proposal's on-chain amount against this so
   *  a proposal that doesn't pay EXACTLY this (a receiver front-running their own
   *  payout with an inflated amount, or a stale post-restore match) is refused. */
  amount_yocto: string | null;
  /** The Sputnik proposal id once proposed; null otherwise. */
  proposal_id: number | null;
  /** A human should look before re-proposing: set when the row was re-queued
   *  because the council VOTED DOWN its proposal (wrong amount/account?), and
   *  cleared by the next claim (markProposed). Ordinary expiry doesn't set it. */
  attention: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Record a payout for an approved submission. Idempotent on submission_id (ON
 * CONFLICT DO NOTHING), so it is safe to call inside reviewSubmission even if a
 * retry re-enters — a submission can only be approved once anyway, but the
 * guard makes the write self-evidently non-doubling.
 */
export async function createPayout(
  taskId: number,
  contributorId: number,
  submissionId: number,
  reward: string,
): Promise<void> {
  await run(
    `INSERT INTO payouts (task_id, contributor_id, submission_id, reward, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, $5)
     ON CONFLICT (submission_id) DO NOTHING`,
    [taskId, contributorId, submissionId, reward, nowIso()],
  );
}

/** A contributor's payouts, newest first. */
export async function listByContributor(contributorId: number): Promise<Payout[]> {
  return many<Payout>('SELECT * FROM payouts WHERE contributor_id = $1 ORDER BY created_at DESC', [contributorId]);
}

/** A single payout by id, or undefined. */
export async function getById(id: number): Promise<Payout | undefined> {
  return one<Payout>('SELECT * FROM payouts WHERE id = $1', [id]);
}

/** A single payout by id, row-locked for the rest of the transaction (or undefined).
 *  Serializes concurrent proposePayout on the same row (the claim-before-submit). */
export async function getByIdForUpdate(id: number): Promise<Payout | undefined> {
  return one<Payout>('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [id]);
}

/** Lock ALL of a contributor's payout rows FOR UPDATE. /forget's money guard
 *  takes this so a concurrent /pay claim (getByIdForUpdate on one of these rows)
 *  serializes behind it — the guard's 'proposed' count can't miss a
 *  pending→proposed flip that commits between the count and the cascade delete.
 *  Ordered by id for a stable lock sequence (deadlock hygiene). */
export async function lockByContributor(contributorId: number): Promise<void> {
  await many('SELECT id FROM payouts WHERE contributor_id = $1 ORDER BY id FOR UPDATE', [contributorId]);
}

/** Payouts in any of `statuses` (oldest first) — the admin funding queue. */
export async function listByStatus(statuses: PayoutStatus[]): Promise<Payout[]> {
  return many<Payout>('SELECT * FROM payouts WHERE status = ANY($1) ORDER BY created_at', [statuses]);
}

/** A task's pending (unstarted) payouts, oldest first — resolves "the payout
 *  task N names" for the admin /pay command. */
export async function listPendingByTask(taskId: number): Promise<Payout[]> {
  return many<Payout>(`SELECT * FROM payouts WHERE task_id = $1 AND status = 'pending' ORDER BY created_at`, [
    taskId,
  ]);
}

/** The council approved and the transfer executed: → paid. The one forward
 *  transition a reconcile can persist (resets go through resetToPending), so
 *  no generic setter exists to write an edge the state machine forbids. */
export async function markPaid(id: number): Promise<void> {
  await run(`UPDATE payouts SET status = 'paid', updated_at = $2 WHERE id = $1`, [id, nowIso()]);
}

/** A Sputnik `Transfer` proposal was submitted: → proposed, pinning the
 *  proposal id (the 1:1 ledger↔chain link), the receiver, and the amount (so
 *  reconcile can refuse any proposal that doesn't pay exactly it).
 *  `proposalId` is null for the pre-submit claim, and stays null when the
 *  OutLayer gateway's returned id failed its identity verification — the
 *  reconciler then adopts the real id by matching the payout's description
 *  (and receiver + amount) once the proposal is visible on-chain
 *  (adopt-or-create). */
export async function markProposed(
  id: number,
  proposalId: number | null,
  accountId: string,
  amountYocto: string,
): Promise<void> {
  await run(
    `UPDATE payouts SET status = 'proposed', proposal_id = $2, account_id = $3, amount_yocto = $4, attention = FALSE, updated_at = $5 WHERE id = $1`,
    [id, proposalId, accountId, amountYocto, nowIso()],
  );
}

/** [DAO] The proposal died before paying (expired/moved/voted down, or an
 *  abandoned claim): proposed → pending so the payout re-enters the queue to be
 *  proposed afresh (a dead proposal stays on-chain for audit). `attention`
 *  persists WHY it's back when the council voted it down — surfaces show it
 *  until the next markProposed clears it, so a rejection an admin must look at
 *  can't render as a plain unstarted row.
 *  `keepClaim` splits the two reset causes:
 *   - false: the row's proposal was SEEN dead on-chain — nothing of that claim
 *     can move money anymore, so receiver/amount clear and the row re-enters
 *     the queue afresh.
 *   - true (the abandoned-claim heal): NO proposal was ever seen — but a
 *     gateway-reported-failed submit may still land later. Keep receiver/amount
 *     as claim memory; reconcile watches for exactly that identity and
 *     adopts/settles it instead of letting a late proposal go invisible
 *     (double-pay via a fresh /pay, erasure past a live Transfer). The watch is
 *     time-bounded by tx validity (CLAIM_MEMORY_TTL_MS in service.ts). */
export async function resetToPending(id: number, attention: boolean, keepClaim = false): Promise<void> {
  await run(
    keepClaim
      ? `UPDATE payouts SET status = 'pending', proposal_id = NULL, attention = $2, updated_at = $3 WHERE id = $1`
      : `UPDATE payouts SET status = 'pending', proposal_id = NULL, account_id = NULL, amount_yocto = NULL, attention = $2, updated_at = $3 WHERE id = $1`,
    [id, attention, nowIso()],
  );
}

export const countByStatus = async (status: PayoutStatus): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM payouts WHERE status = $1', [status]))!.n;

/** How many of a contributor's payouts sit in `status` — the erasure guard's read. */
export const countByContributorStatus = async (contributorId: number, status: PayoutStatus): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM payouts WHERE contributor_id = $1 AND status = $2', [
    contributorId,
    status,
  ]))!.n;

/** A contributor's pending rows still carrying CLAIM MEMORY (a healed claim's
 *  pinned receiver+amount — see resetToPending keepClaim). The erasure guard's
 *  config-gap read: such a row's proposal can only be verified absent via the
 *  chain preflight, which is gated on DAO_CONTRACT_ID — with the var missing,
 *  the memory's mere existence must fail erasure closed. */
export const countPendingClaimMemory = async (contributorId: number): Promise<number> =>
  (await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM payouts WHERE contributor_id = $1 AND status = 'pending' AND account_id IS NOT NULL`,
    [contributorId],
  ))!.n;

