-- 014 — close the escrow→DAO erasure gap and constrain the status domain. The
-- removed escrow (pull) rail walked payout statuses 'claimable' → 'claimed' →
-- 'revoked'; a funded 'claimable' row is real money locked on the escrow contract.
-- The DAO-only /forget guard blocks erasure ONLY on a live 'proposed' proposal, so
-- a leftover 'claimable' row would pass every guard and be cascade-deleted on
-- /forget — stranding the on-chain funds with no ledger record of who or why.
-- ee11402 (the deployed base) IS the escrow model and the status column has no
-- CHECK, so such rows can physically exist in a production DB.
--
-- Fail this migration LOUDLY if any survive, so an operator resolves the on-chain
-- allocation and reconciles those rows BEFORE the DAO-only model goes live, rather
-- than silently deploying over stranded funds. On a clean DB (no escrow claims ever
-- funded) this is a no-op guard. The CHECK then pins the status domain to the three
-- DAO states — defence in depth: a future bug can't write an unmodeled status either.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payouts WHERE status NOT IN ('pending', 'proposed', 'paid')) THEN
    RAISE EXCEPTION 'payouts has rows in a non-DAO status (escrow-model claimable/claimed/revoked?). Resolve the on-chain allocation and reconcile these rows before applying the DAO-only migration.';
  END IF;
END $$;

ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('pending', 'proposed', 'paid'));
