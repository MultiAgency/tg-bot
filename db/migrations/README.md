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

## Conventions (Postgres)

- Autoincrement PKs: `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`.
- Any Telegram user/chat id: `BIGINT` (32-bit `INTEGER` overflows real ids).
  Exception: `notifications.chat_id` is `TEXT` (numeric id *or* an `@username`).
- Real timestamps: `TIMESTAMPTZ`. Free-form text that merely looks date-like
  (e.g. `tasks.deadline`) stays `TEXT`.
