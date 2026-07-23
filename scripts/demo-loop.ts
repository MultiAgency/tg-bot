/**
 * Bot-level demo: drives the apply → assign → submit → review flow through the
 * real Telegraf stack (middleware, session, scenes, callbacks) with the network
 * stubbed. Run: npm run demo (throwaway database).
 */
import assert from 'node:assert';
import { createBot } from '../src/bot/index.js';
import {
  getTask,
  getApplication,
  getApplicationFor,
  latestSubmission,
  listSubmissionVersions,
  getContributor,
  listApplicationsByContributor,
  countSlotsTaken,
  listHistory,
  notificationCounts,
} from '../src/core/service.js';
import { drainNotifications } from '../src/bot/worker.js';
import { nudgeStaleAssignments } from '../src/bot/notify.js';
import { run } from '../src/core/db.js';
import { aiEnabled } from '../src/ai/assist.js';
import { runScript } from './run.js';
import { resetDb } from './testdb.js';
import { createHarness, step } from './harness.js';

const ADMIN = Number(process.env.ADMIN_IDS!.split(',')[0]);
const ALICE = 100;
const BOB = 200;
const CARA = 300;
const USERS: Record<number, { first_name: string; username: string }> = {
  [ADMIN]: { first_name: 'Ada', username: 'ada_admin' },
  [ALICE]: { first_name: 'Alice', username: 'alice' },
  [BOB]: { first_name: 'Bob', username: 'bob' },
  [CARA]: { first_name: 'Cara', username: 'cara' },
};

const bot = createBot();
const harness = createHarness(bot, USERS, {
  // The narrator: every bot send becomes a transcript line, popups get their own.
  log: (entry, method, payload) => {
    if (method === 'answerCallbackQuery') {
      if (payload.text) console.log(`      ⚠️  popup → ${payload.text}`);
      return;
    }
    if (entry.text) {
      const who =
        ({ [ADMIN]: 'admin', [ALICE]: 'alice', [BOB]: 'bob', [CARA]: 'cara' } as Record<number, string>)[
          (entry.chatId as number) ?? -1
        ] ?? entry.chatId;
      console.log(`      🤖 → ${who}: ${entry.text.split('\n')[0]}${entry.text.includes('\n') ? ' …' : ''}`);
    }
  },
});
const { outbound } = harness;

async function say(userId: number, text: string) {
  console.log(`  💬 ${USERS[userId].username}: ${text}`);
  await harness.say(userId, text);
}
async function tap(userId: number, data: string) {
  console.log(`  👆 ${USERS[userId].username} taps [${data}]`);
  await harness.tap(userId, data);
}

async function main(): Promise<void> {
  await resetDb();
  console.log(`AI assist: ${aiEnabled() ? 'ON (live NEAR AI Cloud)' : 'off'}`);

  step('1. Admin creates a task with 2 assignee slots');
  await say(ADMIN, '/newtask');
  await say(ADMIN, 'Write launch thread');
  await say(ADMIN, 'A 5-tweet thread announcing the pilot.');
  await say(ADMIN, '50 USDC');
  await say(ADMIN, '-');
  await say(ADMIN, 'Link to the published thread');
  await say(ADMIN, '2'); // max assignees

  step('2. Admin approves → task open');
  await say(ADMIN, '/approve');
  await tap(ADMIN, 'approve:1');

  step('3. Alice, Bob, Cara apply with pitches');
  await say(ALICE, '/open');
  await tap(ALICE, 'apply:1');
  await say(ALICE, 'Done 3 similar threads');
  await say(BOB, '/open');
  await tap(BOB, 'apply:1');
  await say(BOB, 'Fast turnaround');
  await tap(CARA, 'apply:1');
  await say(CARA, 'Keen to learn');

  const aliceApp = (await getApplicationFor(1, ALICE))!.id;
  const bobApp = (await getApplicationFor(1, BOB))!.id;
  const caraApp = (await getApplicationFor(1, CARA))!.id;

  step('4. Admin reviews applicants: assign Alice + Bob (2 slots), decline Cara');
  await say(ADMIN, '/applicants 1');
  await tap(ADMIN, `assign:${aliceApp}`);
  await tap(ADMIN, `assign:${bobApp}`);
  await tap(ADMIN, `assign:${caraApp}`); // slots full → popup error
  await tap(ADMIN, `decline:${caraApp}`);

  step('5. Alice submits, gets revision, resubmits (v2), approved');
  await say(ALICE, '/myapps');
  await tap(ALICE, `submit:${aliceApp}`);
  await say(ALICE, 'https://x.com/draft-v1');
  const aliceV1 = (await latestSubmission(aliceApp))!.id;
  await tap(ADMIN, `rev:revise:${aliceV1}`);
  await say(ADMIN, 'Add the signup link to tweet 5.');
  await say(ALICE, '/submit');
  await say(ALICE, 'https://x.com/draft-v2');
  const aliceV2 = (await latestSubmission(aliceApp))!.id;
  await tap(ADMIN, `rev:approve:${aliceV2}`);

  step('6. Bob submits long-form → admin reads it in full → rejected');
  await tap(BOB, `submit:${bobApp}`);
  // Longer than the 1000-char card clip, so the review card truncates and
  // carries the "📄 Full submission" button (well under Telegram's 4096 cap).
  const LONG_DRAFT = `my thread draft: ${'x'.repeat(1050)} THE-END`;
  await say(BOB, LONG_DRAFT);
  const bobV1 = (await latestSubmission(bobApp))!.id;
  await tap(ADMIN, `full:${bobV1}`);
  assert.ok(
    outbound.some((o) => o.chatId === ADMIN && o.text === LONG_DRAFT),
    'full submission readable untruncated before deciding',
  );
  await tap(ADMIN, `rev:reject:${bobV1}`);
  await say(ADMIN, 'Off-brand.');

  step('7. Admin views the board, reviews queue, task status');
  await say(ADMIN, '/active');
  await say(ADMIN, '/review');
  await say(ADMIN, '/status 1');

  step('7b. Alice checks /status — sees her own outcomes, not Bob’s');
  await say(ALICE, '/status 1');
  const aliceStatus = [...outbound].reverse().find((o) => o.chatId === ALICE && o.text.includes('🕓 History:'));
  assert.ok(aliceStatus, 'alice got the status view');
  assert.ok(/review: approved/.test(aliceStatus!.text), 'alice sees the review outcome of her own work');
  assert.ok(!/reject/i.test(aliceStatus!.text), "bob's rejection stays invisible to alice");

  step('8. Admin erases Cara (right-to-be-forgotten)');
  await say(ADMIN, `/forget ${CARA}`);

  step('9. Background worker drains the notification queue (rate-limited delivery)');
  const preDrain = outbound.length;
  const drained = await drainNotifications(bot.telegram);
  console.log(`      📮 delivered ${drained} queued notification(s)`);

  // ---- Assertions ----
  const notif = await notificationCounts();
  assert.ok(notif.sent > 0, 'notifications were delivered by the worker');
  assert.equal(notif.failed, 0, 'no notifications failed');
  assert.equal(notif.queued + notif.retrying, 0, 'queue fully drained');
  assert.ok(
    outbound.some((o) => o.chatId === ALICE && /assigned/i.test(o.text)),
    'alice received her assignment DM via the queue',
  );
  assert.ok(
    outbound.some((o) => o.chatId === ALICE && /approved/i.test(o.text)),
    'alice received the approval DM via the queue',
  );
  assert.ok(
    outbound.some((o) => o.chatId === BOB && /wasn.t accepted/i.test(o.text)),
    'bob received the rejection DM via the queue',
  );
  assert.ok(
    outbound.some((o) => o.chatId === ADMIN && o.text.includes('… (truncated')),
    'the review card clipped the long submission (full view is the button)',
  );
  assert.equal((await getTask(1))!.max_assignees, 2, 'task has 2 slots');
  assert.equal(await countSlotsTaken(1), 1, 'alice holds hers (completed); bob’s slot freed by the rejection');
  assert.equal((await getApplication(aliceApp))!.status, 'completed', 'approve closed the assignment as Completed');
  assert.equal((await getApplication(bobApp))!.status, 'rejected', 'reject closed the assignment');
  assert.equal(await getApplication(caraApp), undefined, 'cara erased');
  // Cara was erased BEFORE the queue drained: nothing about her may still deliver —
  // not her queued decline DM, and not the admin application card quoting her pitch.
  assert.ok(
    !outbound.slice(preDrain).some((o) => /Keen to learn/.test(o.text) || o.chatId === CARA),
    'no notification about or to cara delivered after erasure',
  );

  assert.equal((await latestSubmission(aliceApp))!.status, 'approved');
  assert.equal((await latestSubmission(aliceApp))!.version, 2, 'alice on v2');
  assert.equal((await listSubmissionVersions(aliceApp)).length, 2, 'both versions retained');
  assert.equal((await latestSubmission(bobApp))!.status, 'rejected');

  const alice = (await getContributor(ALICE))!;
  assert.equal(alice.applied_count, 1);
  assert.equal(alice.assigned_count, 0, 'completed work is no longer in progress');
  assert.equal(alice.completed_count, 1);
  assert.equal((await getContributor(BOB))!.rejected_count, 1);
  assert.equal(await getContributor(CARA), undefined, 'cara profile gone');
  assert.equal((await listApplicationsByContributor(CARA)).length, 0, 'cara applications gone');

  const history = (await listHistory(1)).map((h) => h.action);
  assert.deepEqual(history, [
    'created', 'approved',
    'applied', 'applied', 'applied',
    'assigned', 'assigned', 'declined',
    'submitted', 'review_revise', 'submitted', 'review_approve', 'completed',
    'submitted', 'review_reject', 'rejected',
    'contributor_forgotten',
  ]);

  // Slot enforcement surfaced as a popup, not a silent assign.
  assert.ok(
    outbound.some((o) => o.method.startsWith('answerC') && /already has 2\/2 assignees/.test(o.text)),
    'assigning a 3rd to a full task was rejected with a popup',
  );

  step('10. Waiting-state notices: a filled last slot and a close reach the rest of the pool');
  const makeTask = async (title: string, slots: string) => {
    await say(ADMIN, '/newtask');
    await say(ADMIN, title);
    await say(ADMIN, 'x');
    await say(ADMIN, '-');
    await say(ADMIN, '-');
    await say(ADMIN, '-');
    await say(ADMIN, slots);
    const draft = [...outbound].reverse().find((o) => o.chatId === ADMIN && /Draft created/i.test(o.text));
    assert.ok(draft, `draft created for "${title}"`);
  };
  await makeTask('Filled-notice task', '1');
  await tap(ADMIN, 'approve:2');
  await tap(ALICE, 'apply:2');
  await say(ALICE, 'me again');
  await tap(BOB, 'apply:2');
  await say(BOB, 'me too');
  const aliceApp2 = (await getApplicationFor(2, ALICE))!.id;
  await tap(ADMIN, `assign:${aliceApp2}`); // takes the ONLY slot → Bob's wait changed shape
  await makeTask('Close-notice task', '1');
  await tap(ADMIN, 'approve:3');
  await tap(BOB, 'apply:3');
  await say(BOB, 'on it');
  await say(ADMIN, '/close 3');
  await drainNotifications(bot.telegram);
  assert.ok(
    outbound.some((o) => o.chatId === BOB && /filled its last slot/.test(o.text)),
    'bob (still applied) heard task 2 filled its last slot',
  );
  assert.ok(
    outbound.some((o) => o.chatId === BOB && /closed before your application/.test(o.text)),
    'bob heard task 3 closed under his undecided application',
  );

  step('11. Pre-stale nudge: an aging assignment warns the assignee before /unassign territory');
  // Age Alice's task-2 assignment past the nudge threshold (staleDays−2 = 5)
  // but not past staleness — the window the sweep exists for.
  await run(`UPDATE applications SET updated_at = now() - interval '6 days' WHERE id = $1`, [aliceApp2]);
  await nudgeStaleAssignments();
  await drainNotifications(bot.telegram);
  assert.ok(
    outbound.some((o) => o.chatId === ALICE && /days ago and nothing has been submitted/.test(o.text)),
    'alice received the pre-stale reminder',
  );
  const nudgesBefore = outbound.filter((o) => o.chatId === ALICE && /days ago and nothing/.test(o.text)).length;
  await nudgeStaleAssignments(); // dedup: a second sweep must not re-nudge the same stint
  await drainNotifications(bot.telegram);
  assert.equal(
    outbound.filter((o) => o.chatId === ALICE && /days ago and nothing/.test(o.text)).length,
    nudgesBefore,
    'a second sweep does not re-nudge the same assignment stint',
  );

  step('12. /stats and /diag: the funnel gauge and the config preflight');
  await say(ADMIN, '/stats');
  const stats = [...outbound].reverse().find((o) => o.chatId === ADMIN && /Product stats/.test(o.text));
  assert.ok(stats, 'stats overview rendered');
  assert.ok(/activation/.test(stats!.text), 'stats includes the activation rate');
  await say(ADMIN, '/diag');
  const diag = [...outbound].reverse().find((o) => o.chatId === ADMIN && /Diagnostics/.test(o.text));
  assert.ok(diag, 'diagnostics rendered');
  assert.ok(/Database reachable/.test(diag!.text), 'diag checked the database');
  // (The announce-chat line depends on the runner's .env — not asserted.)

  step('13. /forgetme: a contributor files their own erasure request');
  await say(BOB, '/forgetme');
  await tap(BOB, 'forgetme:yes');
  await drainNotifications(bot.telegram);
  assert.ok(
    outbound.some((o) => o.chatId === ADMIN && /Erasure request from contributor/.test(o.text)),
    'the admin was alerted with the id to run /forget',
  );

  console.log('\n✅ BOT DEMO PASSED — apply → assign (slots) → versioned submit → review → erasure.');
  console.log(`   history: ${history.join(' → ')}`);
  console.log(`   alice: applied=${alice.applied_count} assigned=${alice.assigned_count} completed=${alice.completed_count}`);
}

runScript(main);
