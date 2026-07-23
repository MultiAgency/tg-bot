import { parseAmount } from 'near-kit';
import { config } from '../config.js';
import { near, timebox } from './client.js';

/**
 * NEAR access to the Sputnik DAO treasury the push-payout model settles through
 * (see PAYOUTS.md). THIS module is read-only — `near.view` reconciliation reads,
 * no keys — and holds the arg builders and amount codecs. The one on-chain
 * WRITE the product makes, `add_proposal`, is signed elsewhere: through the
 * OutLayer TEE wallet (src/near/outlayer.ts — the bot holds an
 * add_proposal-only API key, never a fund-moving key; a printed near-cli
 * fallback once existed and was removed as the root of the duplicate-proposal
 * hazard). The council's `act_proposal` vote that actually releases funds is
 * always a human's own signature, off-bot. Interface verified against
 * `sputnikdao2`.
 */

/** Raw Sputnik proposal status. NB: a proposal whose voting window has lapsed
 *  stays `InProgress` on-chain until someone finalizes it — so effective expiry is
 *  computed client-side off the policy period, see effectiveProposalStatus. */
type ProposalStatus =
  | 'InProgress'
  | 'Approved'
  | 'Rejected'
  | 'Removed'
  | 'Expired'
  | 'Moved'
  | 'Failed';

/** A Sputnik `Transfer` proposal kind — `token_id: ''` == native NEAR (pilot);
 *  an FT contract id otherwise (FT deferred — see PAYOUTS.md storage_deposit note). */
export interface TransferKind {
  Transfer: { token_id: string; receiver_id: string; amount: string; msg: string | null };
}

/** The subset of a Sputnik proposal we read (`get_proposal` → ProposalOutput, its
 *  `id` flattened onto the proposal). `kind` is left loose — we key off `status`. */
export interface Proposal {
  id: number;
  description: string;
  kind: TransferKind | Record<string, unknown>;
  status: ProposalStatus;
  /** Nanoseconds since epoch, decimal string. */
  submission_time: string;
}

/** The subset of the DAO policy we read (`get_policy`). */
export interface Policy {
  /** Exact `add_proposal` deposit, yoctoNEAR decimal string. */
  proposal_bond: string;
  /** Voting window (the approval window, and our expiry basis), nanoseconds. */
  proposal_period: string;
}

/** `add_proposal` gas — mirrors Trezu `nt-cli` (270 TGas). */
export const ADD_PROPOSAL_GAS = '270000000000000';

/** Throws when the DAO isn't configured — "cannot know" must never read as a
 *  settled/absent proposal: a reconciler treating a missing env as a clean null
 *  read would mass-mutate the ledger the day the var disappears. */
function requireDao(): string {
  if (!config.daoContractId) throw new Error('DAO contract not configured (DAO_CONTRACT_ID)');
  return config.daoContractId;
}

// ---- readers (near.view) ----

/** A proposal by id, or null if it doesn't exist. The contract answers a
 *  missing id with a PANIC (`ERR_NO_PROPOSAL`), not a null — and a REMOVED
 *  proposal is deleted from storage, so that panic is also the only way
 *  `Removed` ever reads back (see the reconciler). Normalize exactly that panic
 *  to null; every other failure (transport, timeout) still throws, so "can't
 *  reach the chain" never reads as "proposal gone". */
export async function getProposal(id: number): Promise<Proposal | null> {
  try {
    const p = await timebox(near.view<Proposal | null>(requireDao(), 'get_proposal', { id }), 'get_proposal');
    return p ?? null;
  } catch (err) {
    if (err instanceof Error && err.message.includes('ERR_NO_PROPOSAL')) return null;
    throw err;
  }
}

/** A page of proposals `[from, from+limit)`. Used to recover a lost `proposal_id`
 *  by matching a payout's description (adopt-or-create — see the reconciler). */
export async function getProposals(from: number, limit: number): Promise<Proposal[]> {
  return (await timebox(near.view<Proposal[]>(requireDao(), 'get_proposals', { from_index: from, limit }), 'get_proposals')) ?? [];
}

/** The proposal COUNT — sputnikdao2's `last_proposal_id` is the next id to be
 *  assigned, one PAST the most recent, so live proposals are ids `[0, count)`
 *  (an empty DAO returns 0). Bounds a `getProposals` scan; NOT itself a valid id. */
export async function getLastProposalId(): Promise<number> {
  return (await timebox(near.view<number>(requireDao(), 'get_last_proposal_id', {}), 'get_last_proposal_id')) ?? 0;
}

/** The DAO policy — `proposal_bond` (the exact `add_proposal` deposit) and
 *  `proposal_period` (the approval window; also the client-side expiry basis).
 *  Briefly cached: reconciling a page of payouts reads the policy once, not once
 *  per row, and the values change only via a governance vote — a 60s-stale bond
 *  or period is safely fresh. */
let policyCache: { value: Policy; at: number } | null = null;
const POLICY_TTL_MS = 60_000;

export async function getPolicy(): Promise<Policy> {
  if (policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.value;
  const p = await timebox(near.view<Policy>(requireDao(), 'get_policy', {}), 'get_policy');
  if (!p) throw new Error('DAO returned no policy');
  policyCache = { value: p, at: Date.now() };
  return p;
}

// ---- builders (args + CLI; the wallet signs, the bot never does) ----

/** A Transfer kind paying `amount` (raw, at the token's decimals) to `receiverId`.
 *  `tokenId: ''` == native NEAR (pilot); an FT contract id otherwise. */
export function transferKind(receiverId: string, amount: string, tokenId = ''): TransferKind {
  return { Transfer: { token_id: tokenId, receiver_id: receiverId, amount, msg: null } };
}

/** The payout proposal's description: on-chain traceability WITHOUT a Telegram
 *  identity, AND the idempotency key the reconciler matches to recover a lost id. */
export function payoutDescription(payoutId: number, taskId: number): string {
  return `multiagency payout #${payoutId} task #${taskId}`;
}

/** Exact yoctoNEAR (decimal integer string) → human NEAR, trailing zeros trimmed
 *  ('500000000000000000000000' → '0.5', '1000000000000000000000000' → '1'). Faithful
 *  to the pinned on-chain Transfer amount — no rounding (unlike near-kit's formatAmount,
 *  which fixes 2 decimals and would misstate a payout). Native NEAR only (24 decimals). */
export function formatYoctoNear(yocto: string): string {
  const ONE = 10n ** 24n;
  const y = BigInt(yocto);
  const frac = (y % ONE).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${y / ONE}.${frac}` : `${y / ONE}`;
}

/** The inverse: a human NEAR amount ("0.5") → yoctoNEAR integer string, or
 *  null if it isn't a positive number with ≤24 decimals. The integer part is
 *  bounded to 12 digits: NEAR's total supply is ~1.2 billion, so anything past
 *  that is a typo, not a payout — and callers echo the amount into replies, so
 *  an unbounded string would also blow their message limits. */
export function parseNearToYocto(near: string): string | null {
  if (!/^\d+(\.\d+)?$/.test(near)) return null;
  const [whole, frac = ''] = near.split('.');
  if (whole.length > 12 || frac.length > 24) return null;
  const yocto = parseAmount(`${near} NEAR` as `${number} NEAR`); // format guaranteed by the regex above
  return yocto === '0' ? null : yocto;
}

/** `add_proposal` args — the object the admin's wallet signs (attaching `proposal_bond`). */
export function buildAddProposalArgs(
  description: string,
  kind: TransferKind,
): { proposal: { description: string; kind: TransferKind } } {
  return { proposal: { description, kind } };
}

// ---- (b) status mapping ----

/** The normalized, user-meaningful status of a proposal, mirroring Trezu's
 *  `getProposalStatus`. The load-bearing nuance: Sputnik leaves a proposal
 *  `InProgress` on-chain even after its voting window lapses (it flips only on a
 *  finalize), so expiry is computed client-side from `submission_time +
 *  proposal_period`. The service reconciler maps this onto payout ledger status:
 *    Executed → 'paid' · Failed → keep 'proposed' + alert (re-finalizable) ·
 *    Expired|Rejected|Removed|Moved → 'pending' (re-propose) · Pending → 'proposed'.
 *  `nowMs` is injectable for tests. */
export type EffectiveStatus = 'Executed' | 'Failed' | 'Rejected' | 'Removed' | 'Moved' | 'Expired' | 'Pending';

export function effectiveProposalStatus(proposal: Proposal, policy: Policy, nowMs: number): EffectiveStatus {
  switch (proposal.status) {
    case 'Approved':
      return 'Executed';
    case 'Failed':
      return 'Failed';
    case 'Rejected':
      return 'Rejected';
    case 'Removed':
      return 'Removed';
    case 'Moved':
      return 'Moved';
    case 'Expired':
      return 'Expired';
    case 'InProgress': {
      // Nanoseconds → ms (mirrors Trezu nanosToMs). The magnitude exceeds
      // Number.MAX_SAFE_INTEGER, but the resulting sub-millisecond rounding error
      // is irrelevant to a day-scale voting-window comparison.
      const submittedMs = Number(proposal.submission_time) / 1_000_000;
      const periodMs = Number(policy.proposal_period) / 1_000_000;
      // Declare Expired only well PAST the on-chain window (period + grace), never
      // at the boundary: Sputnik expires on block time, so if the bot clock led
      // chain time we'd reset the payout (clearing proposal_id) while the council
      // could still approve the old proposal — a re-propose double-pay sliver. The
      // grace makes the bot's expiry strictly lag the chain's, closing that window.
      const GRACE_MS = 5 * 60 * 1000;
      return submittedMs + periodMs + GRACE_MS < nowMs ? 'Expired' : 'Pending';
    }
  }
}
