-- 012 — drop the wallet_links table. It backed the parked/now-removed escrow
-- (contributor-pull) payout rail: a Telegram id → NEP-413-proven NEAR account
-- link used to fund and claim allocations. The DAO-push model settles to a typed
-- payout account (contributors.payout_account, migration 010) instead and reads
-- no wallet link, so the table (created by 006, indexed by 007) is now dead
-- schema. Migrations are immutable/checksummed, so the removal is a new forward
-- migration, not an edit of 006/007.
--
-- Before dropping, carry each linked account into the empty payout_account slot:
-- a contributor who completed the NEP-413 flow PROVED control of that account —
-- strictly stronger than the typed-account trust level replacing it — and
-- silently discarding it would reset their payout destination with no notice.
-- An already-typed payout_account wins (it is newer intent). wallet_links is one
-- row per contributor (PK telegram_id); its network column dies with the table —
-- the pilot runs a single network, and /pay re-verifies the account exists on
-- the configured network before any money moves.
UPDATE contributors c
SET payout_account = wl.account_id
FROM wallet_links wl
WHERE c.telegram_id = wl.telegram_id
  AND c.payout_account IS NULL;

DROP INDEX IF EXISTS wallet_links_account_network_idx;
DROP TABLE IF EXISTS wallet_links;
