/** Drop + recreate the schema, then re-migrate. `npm run db:reset` points it at
 *  the LOCAL DEV database (docker-compose); guarded (see scripts/testdb.ts) to
 *  refuse anything that doesn't look local/test/CI, so it can't wipe production. */
import { resetDb } from './testdb.js';
import { SCHEMA_VERSION } from '../src/core/db.js';
import { runScript } from './run.js';

runScript(async () => {
  await resetDb();
  console.log(`database reset (schema version ${SCHEMA_VERSION})`);
});
