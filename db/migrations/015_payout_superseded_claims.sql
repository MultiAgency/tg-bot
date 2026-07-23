-- 015_payout_superseded_claims.sql
-- Claim memory (payouts.account_id + amount_yocto) is a SINGLE slot: the current
-- claim's identity. A printed CLI `add_proposal` command never expires, so when
-- /pay changes a payout's destination (contributor corrected their account, or a
-- new amount) while an earlier command is still un-run, that old identity can't
-- just be overwritten — its command could still create a Transfer nothing on the
-- row remembers (double-pay, or erasure past a live Transfer).
--
-- This table is the WATCHED SET of such superseded identities. The row keeps its
-- current claim; every prior identity whose command may still land is recorded
-- here, so reconcile scans them, /pay refuses to pile a live Transfer on top of a
-- still-movable one, and /forget blocks while any superseded command has a
-- live/re-finalizable (Pending/Failed) proposal — the SAME live-at-check-time
-- guarantee, and the SAME council-backstop residual (a command first going live
-- after the check), that the current claim already has (see forgetContributor).
-- An ALREADY-executed stray no longer blocks (money moved; blocking can't un-move
-- it and would deny erasure forever) — it flags an incident to review. Cascade on
-- payout delete so /forget removes them with the row (no account id — PII-adjacent
-- — outlives the contributor). UNIQUE dedups a destination changed back and forth.
CREATE TABLE payout_superseded_claims (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id    BIGINT NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
  account_id   TEXT   NOT NULL,
  amount_yocto TEXT   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (payout_id, account_id, amount_yocto)
);

CREATE INDEX payout_superseded_claims_payout_idx ON payout_superseded_claims (payout_id);
