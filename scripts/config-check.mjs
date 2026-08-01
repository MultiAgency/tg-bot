/**
 * Offline config checks. Run after `npm run build` so each case imports a fresh
 * dist/config.js in its own Node process with controlled env.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const baseEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  BOT_TOKEN: '000000:demo',
  DATABASE_URL: 'postgresql://x',
};

function readConfig(extraEnv) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import { config } from './dist/config.js'; console.log(JSON.stringify({ ids: [...config.adminIds], source: config.adminIdsSource }));",
    ],
    {
      cwd: process.cwd(),
      env: { ...baseEnv, ...extraEnv },
      encoding: 'utf8',
    },
  );
  if (child.status !== 0) {
    throw new Error(`config import failed:\nstdout=${child.stdout}\nstderr=${child.stderr}`);
  }
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

assert.deepEqual(readConfig({ ADMIN_IDS: '1,2' }), { ids: [1, 2], source: 'ADMIN_IDS' });
assert.deepEqual(readConfig({ ADMIN_IDS: '', ADMIN_TELEGRAM_IDS: '3,4' }), { ids: [3, 4], source: 'ADMIN_TELEGRAM_IDS' });
assert.deepEqual(readConfig({ ADMIN_IDS: '5', ADMIN_TELEGRAM_IDS: '6' }), { ids: [5], source: 'ADMIN_IDS' });

console.log('Config checks OK');
