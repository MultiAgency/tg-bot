-- 006 — wallet links. Maps a contributor's Telegram identity to a NEAR account
-- they proved control of (a NEP-413 signature verified server-side, plus an
-- on-chain check that the signing key is a full-access key on the account). The
-- Mini App uses the link to fund and claim payouts (contracts/escrow): the
-- treasury allocates to account_id, and the contributor claims from it.
--
-- One linked account per contributor (PK telegram_id); re-linking upserts. The
-- FK cascades on /forget, so erasing a contributor removes their wallet link
-- along with their profile — the link is PII (it ties a person to an on-chain
-- account) and must not outlive them (SCOPE.md, right-to-be-forgotten).
CREATE TABLE wallet_links (
  telegram_id  BIGINT PRIMARY KEY REFERENCES contributors(telegram_id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL,
  public_key   TEXT NOT NULL,
  network      TEXT NOT NULL,
  verified_at  TIMESTAMPTZ NOT NULL
);
