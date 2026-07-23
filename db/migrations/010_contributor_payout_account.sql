-- 010_contributor_payout_account.sql
-- DAO-push payouts: a contributor's STANDING payout account — the NEAR account the
-- treasury Transfer is sent to. The contributor TYPES it (no wallet, no signature:
-- in push they only receive, and each sets only their own account, so proof of
-- control is unnecessary — a free on-chain existence check catches a typo). Kept
-- separate from the proof-backed `wallet_links` the parked escrow claim path uses,
-- so the two settlement models don't cross-contaminate trust levels.

ALTER TABLE contributors ADD COLUMN payout_account TEXT;
