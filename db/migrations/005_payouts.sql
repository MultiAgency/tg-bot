-- 005 — payouts. When a submission is approved and its task carries a reward, a
-- payout row is recorded (in the same transaction as the approval) capturing what
-- the contributor is owed. This is the app-side ledger the Mini App reads; turning
-- a payout into an on-chain claim (NEAR claim-contract, contributor-pull) is a
-- later stage — status walks 'pending' → 'claimable' (escrow funded) → 'claimed'.
--
-- reward is snapshotted as free text (tasks.reward is free-form, e.g. "50 USDC"):
-- the machine-readable on-chain amount is resolved when the escrow is funded, not
-- here. One payout per approved submission (UNIQUE), so a re-approval can't double it.
--
-- Erasure: a forgotten contributor's submissions and profile are deleted, and the
-- payout rows keyed to them cascade away with them — payouts hold no fact that
-- outlives the person, honoring /forget (see SCOPE.md, right-to-be-forgotten).
CREATE TABLE payouts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id        BIGINT NOT NULL REFERENCES tasks(id),
  contributor_id BIGINT NOT NULL REFERENCES contributors(telegram_id) ON DELETE CASCADE,
  submission_id  BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reward         TEXT   NOT NULL,
  status         TEXT   NOT NULL DEFAULT 'pending',
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (submission_id)
);

CREATE INDEX payouts_contributor_idx ON payouts (contributor_id);
