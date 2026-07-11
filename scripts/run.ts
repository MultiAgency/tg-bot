/**
 * Shared entry-point runner for the scripts/ suite: run `main`, always close
 * the Postgres pool (the process won't exit while it holds connections), and
 * exit nonzero on failure.
 */
import { closePool } from '../src/core/db.js';

export function runScript(main: () => Promise<void>): void {
  main()
    .then(closePool)
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
