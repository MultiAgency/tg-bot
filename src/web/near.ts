import { Near, verifyNep413Signature, generateNonce, isValidAccountId, type SignedMessage, type SignMessageParams } from 'near-kit';
import { config } from '../config.js';

/**
 * NEAR wallet linking via NEP-413. A contributor proves control of an account by
 * signing a fresh, single-use challenge we issue; we verify the signature AND
 * that the signing key is a full-access key on the claimed account (so possessing
 * a key isn't enough — it must be ON the account). No Better Auth, no second
 * session: the request is already Telegram-authenticated (initData), so the NEAR
 * account is simply recorded against that known user.
 */

/** NEP-413 recipient + message the client signs and the server checks — network-independent, stable. */
export const LINK_RECIPIENT = 'multiagency';
export const LINK_MESSAGE = 'Link this NEAR account to your MultiAgency profile to receive bounty payouts.';

export const linkNetwork = config.nearNetwork === 'mainnet' ? 'mainnet' : 'testnet';
const near = new Near({ network: linkNetwork });

export interface LinkProof {
  accountId: string;
  publicKey: string;
  signature: string;
}

/** True if `publicKey` is a full-access key on `accountId` — binds the signature
 *  to account OWNERSHIP, not mere key possession. Hits the network (view_access_key). */
async function keyIsFullAccessOn(accountId: string, publicKey: string): Promise<boolean> {
  const key = await near.getAccessKey(accountId, publicKey);
  return key?.permission === 'FullAccess';
}

/**
 * Verify a NEP-413 link proof against a specific nonce. `checkKey` is injectable
 * so tests can exercise the crypto path deterministically; production uses the
 * real on-chain full-access check.
 */
export async function verifyLinkProof(
  proof: LinkProof,
  nonce: Uint8Array,
  checkKey: (accountId: string, publicKey: string) => Promise<boolean> = keyIsFullAccessOn,
): Promise<boolean> {
  if (!isValidAccountId(proof.accountId)) return false;
  const params: SignMessageParams = { message: LINK_MESSAGE, recipient: LINK_RECIPIENT, nonce };
  const signed: SignedMessage = { accountId: proof.accountId, publicKey: proof.publicKey, signature: proof.signature };
  if (!(await verifyNep413Signature(signed, params, { nonceValidation: 'none' }))) return false;
  return checkKey(proof.accountId, proof.publicKey);
}

// ---- nonce issuance (RAM-only, single-use, TTL) — the anti-replay challenge ----
const NONCE_TTL_MS = 5 * 60_000;
const MAX_NONCES = 5000;
const nonces = new Map<number, { nonce: Uint8Array; expiresAt: number }>();

/** Issue a fresh challenge nonce for a Telegram user (overwrites any prior one). */
export function issueNonce(telegramId: number, now: number = Date.now()): Uint8Array {
  const nonce = generateNonce();
  // Delete-then-set keeps Map iteration order = least-recently-issued first,
  // making the eviction below LRU.
  nonces.delete(telegramId);
  nonces.set(telegramId, { nonce, expiresAt: now + NONCE_TTL_MS });
  if (nonces.size > MAX_NONCES) {
    for (const [k, v] of nonces) if (v.expiresAt <= now) nonces.delete(k);
    // Still over (a flood of distinct authed users inside one TTL): evict the
    // least-recently-issued so MAX_NONCES is a real bound, not advisory.
    for (const oldest of nonces.keys()) {
      if (nonces.size <= MAX_NONCES) break;
      nonces.delete(oldest);
    }
  }
  return nonce;
}

/** Consume the issued nonce if it matches and is unexpired — single use. */
export function consumeNonce(telegramId: number, nonceB64: string, now: number = Date.now()): Uint8Array | null {
  const entry = nonces.get(telegramId);
  if (!entry || entry.expiresAt <= now) return null;
  const provided = Buffer.from(nonceB64, 'base64');
  if (provided.length !== entry.nonce.length || !Buffer.from(entry.nonce).equals(provided)) return null;
  nonces.delete(telegramId);
  return entry.nonce;
}
