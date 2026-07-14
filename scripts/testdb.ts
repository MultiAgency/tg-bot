import { query, initSchema, TEST_SCHEMA } from '../src/core/db.js';

/**
 * TEST-ONLY: drop and recreate the public schema, then re-apply migrations, for a
 * clean database per demo run. Never imported by runtime code (`src/**`).
 *
 * Guarded against production: it refuses unless DATABASE_URL clearly points at a
 * local/test/CI Postgres, or ALLOW_DB_RESET=1 is set explicitly. A Railway
 * production URL will not match, so a stray `npm run db:reset` can't wipe live data.
 */
export async function resetDb(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const looksLikeTest = /localhost|127\.0\.0\.1|@postgres[:/]|[/_-]test|[/_-]ci\b/i.test(url);
  if (!looksLikeTest && process.env.ALLOW_DB_RESET !== '1') {
    throw new Error(
      'resetDb refused: DATABASE_URL does not look like a local/test/CI target. ' +
        'Set ALLOW_DB_RESET=1 to override.',
    );
  }
  // Reset THIS process's schema — its own isolated one under test isolation
  // (TEST_SCHEMA), else public. Isolation means a concurrent demo's reset targets
  // a different schema and can't drop the tables out from under this one.
  const schema = TEST_SCHEMA ?? 'public';
  await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
  await initSchema();
}
