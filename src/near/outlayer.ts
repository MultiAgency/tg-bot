import { config } from '../config.js';
import { ADD_PROPOSAL_GAS, buildAddProposalArgs, type TransferKind } from './dao.js';

/**
 * OutLayer agent custody (fastnear.com) — how the bot submits a Sputnik
 * `add_proposal` WITHOUT holding a fund-moving key.
 *
 * The bot authenticates with an API key only; the signing key is derived and used
 * inside OutLayer's TEE (Intel TDX) and never exists in this process. Even a full
 * server compromise yields the API key, not a signing key — and a tight OutLayer
 * policy (call-only, DAO address-whitelist, rate limit, no signing capabilities —
 * see docs/outlayer-setup.md) boxes that key to "propose to the DAO, ≤N/hr".
 *
 * This module can submit NOTHING BUT `add_proposal`: propose-only, non-custodial.
 * A proposal still needs the DAO's human `Approver` vote to execute, so a stolen
 * key can queue proposals (gated by that vote + the operator's freeze) but can
 * never transfer, vote, or move funds. Keep the bot's OutLayer wallet a DAO
 * `Requestor` ONLY — never an `Approver`.
 */

const BASE =
  config.outlayerBaseUrl ||
  (config.nearNetwork === 'mainnet' ? 'https://api.outlayer.fastnear.com' : 'https://testnet-api.outlayer.fastnear.com');

/** Whether the OutLayer proposer path is wired (API key + DAO both set). */
export function outlayerConfigured(): boolean {
  return !!config.outlayerApiKey && !!config.daoContractId;
}

/**
 * Submit a Sputnik `Transfer` proposal to the DAO through the bot's OutLayer
 * custody wallet and return the new proposal id. `bond` is the DAO's
 * `proposal_bond` (yoctoNEAR) attached as the deposit — 0 on the pilot DAO, so
 * the call moves none of the wallet's funds. Throws on any non-success so callers
 * fail closed (no phantom proposal id).
 */
export async function submitDaoProposal(description: string, kind: TransferKind, bond = '0'): Promise<number> {
  // Module-boundary asserts, unreachable via the current sole caller
  // (proposePayout gates on outlayerConfigured() with a user-facing message
  // first) — they exist so a future direct caller fails loudly here rather
  // than POSTing a broken request to the gateway.
  if (!config.outlayerApiKey) throw new Error('OutLayer not configured (OUTLAYER_API_KEY)');
  if (!config.daoContractId) throw new Error('DAO not configured (DAO_CONTRACT_ID)');

  const res = await fetch(`${BASE}/wallet/v1/call`, {
    method: 'POST',
    // Bounded like every other external call: a gateway that accepts the
    // connection and hangs would otherwise pin /pay (and the polling batch)
    // for undici's multi-minute default. On timeout the caller's "submitted
    // but unverified" handling applies — fail closed, never re-run /pay blind.
    signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.outlayerApiKey}` },
    body: JSON.stringify({
      receiver_id: config.daoContractId,
      method_name: 'add_proposal',
      args: buildAddProposalArgs(description, kind),
      gas: ADD_PROPOSAL_GAS,
      deposit: bond,
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    status?: string;
    result?: unknown;
    tx_hash?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok || json.status !== 'success') {
    throw new Error(`OutLayer add_proposal failed (HTTP ${res.status}): ${json.error ?? json.message ?? 'unknown'}`);
  }
  // /wallet/v1/call returns the contract method's return value in `result`.
  // add_proposal returns the new proposal id (u64) — but a NEAR call return is a
  // base64 SuccessValue by convention, and gateways vary on whether they decode
  // it, so accept a number, a numeric string, or a base64-encoded numeric.
  return parseProposalId(json.result);
}

function parseProposalId(result: unknown): number {
  if (typeof result === 'number' && Number.isInteger(result) && result >= 0) return result;
  if (typeof result === 'string') {
    // Strict digits only — Number('') and Number('   ') coerce to 0, so a blank
    // SuccessValue (a gateway that strips the return value) must fail closed
    // here, never parse as proposal id 0.
    const direct = result.trim();
    if (/^\d+$/.test(direct)) return Number(direct);
    const decoded = Buffer.from(direct, 'base64').toString('utf8').replace(/"/g, '').trim();
    if (/^\d+$/.test(decoded)) return Number(decoded);
  }
  throw new Error(`OutLayer add_proposal returned no parseable proposal id (result=${JSON.stringify(result)})`);
}
