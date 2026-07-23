import { AccountDoesNotExistError, isValidAccountId } from 'near-kit';
import { near, timebox } from './client.js';

/**
 * NEAR account checks for typed payout accounts. In the DAO-push model a
 * contributor only RECEIVES, so they give their NEAR account as plain text — no
 * wallet, no signature. Proof-of-control is unnecessary (each contributor sets
 * only their own payout account, gated by their Telegram identity; the worst case
 * of a typed account is their own payout misrouting). What we DO owe them is
 * catching a typo before the treasury proposes a Transfer to a dead address — a
 * free on-chain existence read stands in for the signature.
 */

/** NEAR account-id syntax (named like `alice.testnet`, or a 64-char implicit id).
 *  A cheap pre-filter so we don't RPC obviously-malformed input. */
export { isValidAccountId };

/** True iff `accountId` exists on-chain (a `view_account` query resolves). The RPC
 *  is authoritative — a malformed or nonexistent id yields an error, not a result.
 *  Throws only on a transport failure, so callers can distinguish "doesn't exist"
 *  (false) from "couldn't check" (throw) and fail closed on the latter. */
export async function accountExists(accountId: string): Promise<boolean> {
  if (!isValidAccountId(accountId)) return false;
  try {
    await timebox(near.getAccount(accountId), 'view_account');
    return true;
  } catch (err) {
    if (err instanceof AccountDoesNotExistError) return false;
    throw err;
  }
}
