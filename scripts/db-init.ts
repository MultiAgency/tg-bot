/** Apply any pending migrations to DATABASE_URL, then exit. `npm run db:init`. */
import { initSchema, SCHEMA_VERSION } from '../src/core/db.js';
import { runScript } from './run.js';

runScript(async () => {
  await initSchema();
  console.log(`schema up to date (version ${SCHEMA_VERSION})`);
});
