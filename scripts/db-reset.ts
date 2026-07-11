/** Drop + recreate the schema on a TEST DATABASE_URL, then re-migrate. `npm run db:reset`.
 *  Guarded (see scripts/testdb.ts) so it can't wipe a production database. */
import { resetDb } from './testdb.js';
import { SCHEMA_VERSION } from '../src/core/db.js';
import { runScript } from './run.js';

runScript(async () => {
  await resetDb();
  console.log(`database reset (schema version ${SCHEMA_VERSION})`);
});
