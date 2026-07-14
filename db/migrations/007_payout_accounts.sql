-- 007 — pin money to accounts. Two fixes to the payout identity model, closing
-- the holes a full review found (2026-07-13): every money decision used to be
-- re-derived from the contributor's CURRENT wallet link, which they can rewrite
-- at any time.
--
-- payouts.account_id: the NEAR account the escrow was observed funded to, set
-- the moment reconciliation first sees the on-chain allocation (pending →
-- claimable). From then on, reconciliation and the /forget money guard read the
-- chain against THIS account — a later re-link can no longer make a funded
-- payout read as settled, hide it from erasure's preflight, or get it funded a
-- second time to the new account. NULL means funding has not been observed yet
-- (the re-link guard in service.upsertWalletLink covers that window by checking
-- the outgoing account directly).
--
-- Status gains 'revoked' (no CHECK constraint exists to widen): the contract now
-- records HOW an allocation left (claim vs owner revoke) in a tombstone, so a
-- treasury revoke is recorded as "returned", never falsely as "paid".
ALTER TABLE payouts ADD COLUMN account_id TEXT;

-- One NEAR account per contributor per network. Without this, two contributors
-- sharing a wallet on the same multi-assignee task collide on the contract's
-- (task, account) key: one funded allocation would mark both ledger rows
-- claimable and one payment would satisfy two debts.
CREATE UNIQUE INDEX wallet_links_account_network_idx ON wallet_links (account_id, network);
