import { many, run, nowIso } from '../db.js';

/**
 * A payout owed to a contributor for approved work (see migrations 005 + 007).
 * The row is the app-side ledger; the on-chain claim is a later stage. Status:
 *   pending    — recorded on approval, no escrow funding observed yet
 *   claimable  — the claim escrow was observed funded on-chain; account_id pins
 *                WHICH account it was funded to (money decisions read the chain
 *                against the pinned account, immune to a later re-link)
 *   claimed    — the contributor pulled it (observed via the contract's
 *                Claimed tombstone; terminal)
 *   revoked    — the treasury reclaimed the funds (Revoked tombstone; terminal —
 *                recorded as "returned", never falsely as "paid")
 */
export type PayoutStatus = 'pending' | 'claimable' | 'claimed' | 'revoked';

export interface Payout {
  id: number;
  task_id: number;
  contributor_id: number;
  submission_id: number;
  reward: string;
  status: PayoutStatus;
  /** The NEAR account the escrow was funded to, pinned when funding is first
   *  observed; null while pending (no funding seen yet). */
  account_id: string | null;
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

/** Payouts in any of `statuses` (oldest first) — the admin funding queue. */
export async function listByStatus(statuses: PayoutStatus[]): Promise<Payout[]> {
  return many<Payout>('SELECT * FROM payouts WHERE status = ANY($1) ORDER BY created_at', [statuses]);
}

/** Advance a payout's status (claimable → claimed | revoked, per the tombstone). */
export async function setStatus(id: number, status: PayoutStatus): Promise<void> {
  await run('UPDATE payouts SET status = $2, updated_at = $3 WHERE id = $1', [id, status, nowIso()]);
}

/** Funding observed on-chain: pending → claimable, pinning the funded account so
 *  every later money decision is immune to a wallet re-link. */
export async function markFunded(id: number, accountId: string): Promise<void> {
  await run(`UPDATE payouts SET status = 'claimable', account_id = $2, updated_at = $3 WHERE id = $1`, [
    id,
    accountId,
    nowIso(),
  ]);
}

/** How many of a contributor's payouts sit in `status` — the erasure guard's read. */
export async function countByContributorStatus(contributorId: number, status: PayoutStatus): Promise<number> {
  const rows = await many<{ n: string }>(
    'SELECT COUNT(*) AS n FROM payouts WHERE contributor_id = $1 AND status = $2',
    [contributorId, status],
  );
  return Number(rows[0]?.n ?? 0);
}
