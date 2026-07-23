# Database migrations

Sequential, forward-only schema migrations applied at startup by `initSchema()`
(`src/core/db.ts`). Each `NNN_name.sql` file is applied exactly once, in numeric
order, inside a transaction; the applied version + a content checksum are recorded
in the `schema_migrations` table.

## The one rule: applied migrations are immutable

**Once a migration file has been applied anywhere, never edit, rename, or "fix" it
in place.** Deployed databases have already run it, and the startup checksum guard
will refuse to boot if an applied file's contents change.

Every schema change — *including a correction to a previous migration* — is a new,
higher-numbered file (`003_*.sql`, `004_*.sql`, …). Numbers must stay contiguous
(`001, 002, 003, …`); a gap fails startup.

**Comments in applied migrations can go stale and cannot be fixed in place.** They
describe the schema as it was *when written*, not the current model. Notably,
`005`–`010` describe the removed NEAR "claim escrow" (contributor-pull) payout
rail — `claimable`/`claimed`/`revoked` statuses, `wallet_links`, on-chain
`get_allocation` — which no longer exists: payouts are DAO-push only (`pending`/
`proposed`/`paid`), `wallet_links` is dropped by `012`, and the `/forget` money
guard reads DAO proposal state, not escrow allocations. Likewise `015` describes
the watched superseded-claims set built for the printed-CLI proposer fallback;
both were removed the same day the fallback was (the OutLayer TEE wallet is the
single proposer) — `016` drops the table and explains the replacement (bounded
claim-memory expiry + a destination-change refusal). Trust the code
(`src/core/`), not these historical comments.

## Conventions (Postgres)

- Autoincrement PKs: `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`.
- Any Telegram user/chat id: `BIGINT` (32-bit `INTEGER` overflows real ids).
  Exception: `notifications.chat_id` is `TEXT` (numeric id *or* an `@username`).
- Real timestamps: `TIMESTAMPTZ`. Free-form text that merely looks date-like
  (e.g. `tasks.deadline`) stays `TEXT`.
