-- 009_payout_proposals.sql
-- DAO-push payouts (PAYOUTS.md): a payout is settled by a Sputnik DAO `Transfer`
-- proposal instead of the pull-escrow. ADDITIVE to the escrow model (parked, not
-- removed) — this only pins the proposal id. The DAO status values
-- (proposed/paid/declined) coexist with the escrow ones (claimable/claimed/revoked)
-- in the CHECK-less `status` column, so both settlement models run side by side
-- through the transition; existing rows are left untouched.

ALTER TABLE payouts ADD COLUMN proposal_id BIGINT;

-- The 1:1 payout↔proposal link; also bounds the adopt-by-description recovery scan.
CREATE INDEX payouts_proposal_id_idx ON payouts (proposal_id) WHERE proposal_id IS NOT NULL;
