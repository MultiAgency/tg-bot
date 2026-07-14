import { one, run, nowIso } from '../db.js';

/**
 * A contributor's linked NEAR account (see migration 006). One per contributor;
 * re-linking replaces it. Written only after a NEP-413 proof is verified in the
 * web tier (src/web/near.ts), so a row here means the person controls the account.
 */
export interface WalletLink {
  telegram_id: number;
  account_id: string;
  public_key: string;
  network: string;
  verified_at: string;
}

/** Link (or re-link) a contributor's NEAR account. */
export async function upsertLink(
  telegramId: number,
  accountId: string,
  publicKey: string,
  network: string,
): Promise<void> {
  await run(
    `INSERT INTO wallet_links (telegram_id, account_id, public_key, network, verified_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (telegram_id) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       public_key = EXCLUDED.public_key,
       network = EXCLUDED.network,
       verified_at = EXCLUDED.verified_at`,
    [telegramId, accountId, publicKey, network, nowIso()],
  );
}

export async function getLink(telegramId: number): Promise<WalletLink | undefined> {
  return one<WalletLink>('SELECT * FROM wallet_links WHERE telegram_id = $1', [telegramId]);
}
