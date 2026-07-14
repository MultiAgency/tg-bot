import { Near } from 'near-kit';
import { config } from '../config.js';

/**
 * Read-only NEAR access to the claim escrow (contracts/escrow). The bot never
 * signs — funding (`allocate`) is a treasury action the admin runs themselves
 * (see allocateCommand). The bot's only on-chain role is to READ allocations, so
 * it can tell an admin which payouts are funded and flip their status to
 * claimable. Read-only ⇒ no keys here.
 */

const near = new Near({ network: config.nearNetwork === 'mainnet' ? 'mainnet' : 'testnet' });

export interface Allocation {
  /** yoctoNEAR, as a decimal string. */
  amount: string;
}
// Presence of an Allocation == funded and unclaimed. Removal writes a Settlement
// tombstone ('Claimed' | 'Revoked') on-chain, so how the money left is OBSERVED
// via getSettlement — never inferred from absence (absence alone can't tell a
// claim from a revoke, and is gameable by claiming before the ledger's next read).

export type Settlement = 'Claimed' | 'Revoked';

/** Throws when the escrow contract isn't configured — "cannot know" must never
 *  read as "unfunded": a reconciler treating it as a successful null read would
 *  mass-convert funded payouts to settled the day the env var goes missing. */
function requireEscrow(): string {
  if (!config.escrowContractId) throw new Error('escrow contract not configured (ESCROW_CONTRACT_ID)');
  return config.escrowContractId;
}

/** The on-chain allocation for a (task, account) on the escrow, or null if unfunded. */
export async function getAllocation(taskId: number, accountId: string): Promise<Allocation | null> {
  const a = await near.view<Allocation | null>(requireEscrow(), 'get_allocation', {
    task_id: taskId,
    account_id: accountId,
  });
  return a ?? null;
}

/** How the last allocation on (task, account) settled — check getAllocation
 *  first; a live allocation wins over a stale tombstone from a re-allocate. */
export async function getSettlement(taskId: number, accountId: string): Promise<Settlement | null> {
  const s = await near.view<Settlement | null>(requireEscrow(), 'get_settlement', {
    task_id: taskId,
    account_id: accountId,
  });
  return s ?? null;
}

/** Render yoctoNEAR as a human NEAR amount (trailing zeros trimmed), e.g. "0.05". */
export function formatNear(yocto: string): string {
  const padded = yocto.padStart(25, '0');
  const whole = padded.slice(0, -24).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(-24, -20).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * The exact near-cli command a treasury admin runs to fund a payout — the amount
 * is theirs to set (`reward` is free text, so the bot never guesses a figure).
 * The bot prints this; it does not run it (no treasury key on the server).
 */
export function allocateCommand(taskId: number, accountId: string): string {
  const contract = config.escrowContractId || 'escrow.<treasury>.testnet';
  const treasury = config.nearTreasuryId || '<treasury-account>';
  return (
    `near contract call-function as-transaction ${contract} allocate ` +
    `json-args '{"task_id":${taskId},"account_id":"${accountId}"}' ` +
    `prepaid-gas '30 Tgas' attached-deposit '<AMOUNT> NEAR' ` +
    `sign-as ${treasury} network-config ${config.nearNetwork} sign-with-legacy-keychain send`
  );
}
