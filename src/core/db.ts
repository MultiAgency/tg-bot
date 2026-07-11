import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';

/**
 * PostgreSQL access layer.
 *
 * Three entities:
 *   task        — a unit of work (a container). Draft → Open → Closed.
 *   application — a contributor's expression of interest + selection.
 *   submission  — the work delivered by an assigned contributor, versioned.
 * task_history is a per-task audit log; notifications is the outbound queue;
 * rooms/room_admins/signals back group-chat signal detection.
 *
 * Concurrency model: the process is the single long-poller of the bot token, so
 * there is one logical writer. Statements run on a connection Pool. A service
 * mutator opens ONE transaction via withTransaction(); every model read/write it
 * calls transparently joins that transaction's client through AsyncLocalStorage —
 * models stay transaction-agnostic (they never receive a client), exactly as they
 * were under synchronous better-sqlite3.
 */

const { Pool, types } = pg;

// timestamptz (OID 1184) → canonical ISO-8601 string, so the app keeps its
// string contract (created_at/updated_at/next_attempt_at are strings everywhere)
// while the columns are real timestamps in the database.
types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
// BIGINT (OID 20) → JS number. pg returns int8 as a string by default, which would
// break every `id: number` field and id comparison. Telegram ids and our identity
// keys are all well within 2^53, so Number is safe. COUNT(*) (also int8) likewise
// comes back as a number.
types.setTypeParser(20, (v: string) => Number(v));

const pool = new Pool({ connectionString: config.databaseUrl });

// A pooled connection dropped while IDLE (Railway maintenance/failover, an
// idle-session timeout, a network blip) surfaces only as a Pool 'error' event —
// pg documents this listener as required. Without it, Node treats the emit as an
// unhandled 'error' and crashes the single long-polling process. Log and carry
// on: the pool discards the dead client and the next query dials a fresh one.
pool.on('error', (err) => {
  console.error('[db] idle pool client error (recovered):', err instanceof Error ? err.message : err);
});

/** The client bound to the current transaction, if any (set by withTransaction). */
const txClient = new AsyncLocalStorage<PoolClient>();
function executor(): Pick<PoolClient, 'query'> {
  return txClient.getStore() ?? pool;
}

/** Run a query on the pool or the active transaction's client. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return executor().query<T>(text, params as never);
}

/** First row, or undefined. */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | undefined> {
  return (await query<T>(text, params)).rows[0];
}

/** All rows. */
export async function many<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  return (await query<T>(text, params)).rows;
}

/** Rows affected (INSERT/UPDATE/DELETE). */
export async function run(text: string, params?: unknown[]): Promise<number> {
  return (await query(text, params)).rowCount ?? 0;
}

/**
 * Check out a pooled client and run `fn(client)` inside BEGIN/COMMIT, rolling back
 * on error. Shared by withTransaction and the migration runner so both get the
 * same two protections:
 *   - a client 'error' listener: a checked-out client is off the pool, so the
 *     pool's idle 'error' handler no longer covers it. A mid-transaction
 *     connection drop (Railway failover, idle-session timeout, network blip) emits
 *     'error' on the client itself — with no listener Node treats it as unhandled
 *     and crashes the single long-polling process. Absorbing it lets the failed
 *     query reject and be handled by the catch below.
 *   - a non-masking ROLLBACK: a ROLLBACK that itself fails (e.g. the connection is
 *     already dead) must not replace the error that actually aborted the work.
 */
async function inClientTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const onClientError = (err: unknown) =>
    console.error('[db] transaction client error:', err instanceof Error ? err.message : err);
  client.on('error', onClientError);
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[db] ROLLBACK failed:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
      }
      throw err;
    }
  } finally {
    client.removeListener('error', onClientError);
    client.release();
  }
}

/**
 * Run `fn` inside a single transaction. Every query it issues (directly or via
 * models) runs on the same client through AsyncLocalStorage. Nested calls join
 * the outer transaction rather than opening a new one.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (txClient.getStore()) return fn();
  // Bind the client to AsyncLocalStorage so every query fn issues (directly or via
  // models) routes to it; BEGIN/COMMIT are managed by inClientTransaction.
  return inClientTransaction((client) => txClient.run(client, fn));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function closePool(): Promise<void> {
  await pool.end();
}

// ---- Migrations ----

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

/** Load db/migrations/NNN_*.sql, sorted, with a contiguity (1..N) check. */
function loadMigrations(): Migration[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const migrations = files.map((name) => {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    return {
      version: Number(name.split('_')[0]),
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migration numbering gap: expected ${i + 1}, found ${m.name}. Numbers must be contiguous (1..N).`);
    }
  });
  return migrations;
}

const MIGRATIONS = loadMigrations();

/** What the schema is at, once initSchema() has run. Tests assert against this. */
export const SCHEMA_VERSION = MIGRATIONS.length;

// A fixed key for the migration advisory lock — any constant works as long as
// every instance uses the same one. Serializes booters against each other only.
const MIGRATION_LOCK_KEY = 8_274_301;

/**
 * Postgres SQLSTATEs for "this object already exists": duplicate table/index
 * (42P07), column (42701), object such as a constraint (42710), or schema
 * (42P06). Used to turn a pre-seeded-database migration failure into a clear
 * diagnostic instead of a cryptic raw error.
 */
function isDuplicateObjectError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P07' || code === '42701' || code === '42710' || code === '42P06';
}

/**
 * Apply pending migrations, once each, transactionally. Records applied version +
 * checksum; refuses to boot if an already-applied migration file's contents have
 * changed (checksum drift) — applied migrations are immutable (db/migrations/README).
 *
 * The whole apply loop runs under a session-level advisory lock so two instances
 * booting concurrently (e.g. a rolling deploy, or a stray second process) can't
 * both try to apply the same not-yet-recorded migration and collide. numReplicas
 * is 1 today, but the lock is cheap and makes startup correct under any count:
 * the second booter blocks until the first finishes, then re-reads the applied
 * set and sees there is nothing left to do.
 */
export async function initSchema(): Promise<void> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INT PRIMARY KEY,
         checksum   TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    // Read the applied set while HOLDING the lock: a booter that waited here sees
    // every migration the instance ahead of it just committed, and skips them.
    const applied = new Map<number, string>(
      (await pool.query<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const m of MIGRATIONS) {
      const priorChecksum = applied.get(m.version);
      if (priorChecksum !== undefined) {
        if (priorChecksum !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied (checksum mismatch). Applied migrations are immutable.`);
        }
        continue;
      }
      try {
        await inClientTransaction(async (client) => {
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [m.version, m.checksum]);
        });
      } catch (err) {
        // A not-yet-recorded migration whose objects already exist means the
        // database carries the schema OUTSIDE the tracker (a restored, branched,
        // or hand-created DB) — the case the old SQLite `CREATE TABLE IF NOT
        // EXISTS` silently absorbed. Raw, it crash-loops boot with a cryptic
        // "relation already exists"; name the real cause and the fix instead.
        // Any other failure rethrows untouched.
        if (isDuplicateObjectError(err)) {
          throw new Error(
            `Migration ${m.name} could not be applied: it creates an object that already ` +
              `exists, yet no schema_migrations row records it as applied. The database was ` +
              `likely seeded with the schema outside the migration tracker (a restored, ` +
              `branched, or manually created DB). Baseline it by inserting the already-applied ` +
              `versions into schema_migrations, or deploy against an empty database. ` +
              `(Postgres ${(err as { code?: string }).code}: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
        throw err;
      }
    }
  } finally {
    // Release explicitly (session-level locks outlive a transaction); the pool
    // reuses this connection afterward, so a lingering lock would be a real leak.
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lockClient.release();
  }
}
