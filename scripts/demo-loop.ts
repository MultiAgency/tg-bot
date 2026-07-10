/**
 * Bot-level demo: drives the apply → assign → submit → review flow through the
 * real Telegraf stack (middleware, session, scenes, callbacks) with the network
 * stubbed. Run: npm run demo (throwaway database).
 */
import assert from 'node:assert';
import { Telegram } from 'telegraf';
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
import { aiEnabled } from '../src/ai/assist.js';

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
bot.botInfo = { id: 999, is_bot: true, first_name: 'Demo', username: 'DemoBot' } as never;

interface Outbound { method: string; chatId: number | undefined; text: string }
const outbound: Outbound[] = [];
let msgId = 1000;

(Telegram.prototype as unknown as { callApi: (m: string, p: Record<string, unknown>) => Promise<unknown> }).callApi =
  async (method, payload) => {
    const text = String(payload.text ?? payload.caption ?? '');
    const chatId = payload.chat_id as number | undefined;
    outbound.push({ method, chatId, text });
    if (method === 'answerCallbackQuery' || method === 'answerCbQuery') {
      if (payload.text) console.log(`      ⚠️  popup → ${payload.text}`);
      return true;
    }
    if (text) {
      const who = ({ [ADMIN]: 'admin', [ALICE]: 'alice', [BOB]: 'bob', [CARA]: 'cara' } as Record<number, string>)[chatId ?? -1] ?? chatId;
      console.log(`      🤖 → ${who}: ${text.split('\n')[0]}${text.includes('\n') ? ' …' : ''}`);
    }
    if (method === 'editMessageText') return true;
    return { message_id: msgId++, chat: { id: chatId ?? 0 }, date: 0, text };
  };

let updateId = 1;
const from = (id: number) => ({ id, is_bot: false, ...USERS[id] });

async function say(userId: number, text: string) {
  console.log(`  💬 ${USERS[userId].username}: ${text}`);
  const entities = text.startsWith('/') ? [{ offset: 0, length: text.split(/[\s@]/)[0].length, type: 'bot_command' }] : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: msgId++, from: from(userId), chat: { id: userId, type: 'private', first_name: USERS[userId].first_name }, date: 0, text, ...(entities ? { entities } : {}) },
  } as never);
}
async function tap(userId: number, data: string) {
  console.log(`  👆 ${USERS[userId].username} taps [${data}]`);
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: { id: String(updateId), from: from(userId), chat_instance: 'demo', data, message: { message_id: msgId++, from: { id: 999, is_bot: true, first_name: 'Demo' }, chat: { id: userId, type: 'private' }, date: 0, text: 'card' } },
  } as never);
}
const step = (t: string) => console.log(`\n▶ ${t}`);

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

const aliceApp = getApplicationFor(1, ALICE)!.id;
const bobApp = getApplicationFor(1, BOB)!.id;
const caraApp = getApplicationFor(1, CARA)!.id;

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
const aliceV1 = latestSubmission(aliceApp)!.id;
await tap(ADMIN, `rev:revise:${aliceV1}`);
await say(ADMIN, 'Add the signup link to tweet 5.');
await say(ALICE, '/submit');
await say(ALICE, 'https://x.com/draft-v2');
const aliceV2 = latestSubmission(aliceApp)!.id;
await tap(ADMIN, `rev:approve:${aliceV2}`);

step('6. Bob submits long-form → admin reads it in full → rejected');
await tap(BOB, `submit:${bobApp}`);
// Longer than the 1000-char card clip, so the review card truncates and
// carries the "📄 Full submission" button (well under Telegram's 4096 cap).
const LONG_DRAFT = `my thread draft: ${'x'.repeat(1050)} THE-END`;
await say(BOB, LONG_DRAFT);
const bobV1 = latestSubmission(bobApp)!.id;
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
const notif = notificationCounts();
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
  outbound.some((o) => o.chatId === BOB && /rejected/i.test(o.text)),
  'bob received the rejection DM via the queue',
);
assert.ok(
  outbound.some((o) => o.chatId === ADMIN && o.text.includes('… (truncated')),
  'the review card clipped the long submission (full view is the button)',
);
assert.equal(getTask(1)!.max_assignees, 2, 'task has 2 slots');
assert.equal(countSlotsTaken(1), 1, 'alice holds hers (completed); bob’s slot freed by the rejection');
assert.equal(getApplication(aliceApp)!.status, 'completed', 'approve closed the assignment as Completed');
assert.equal(getApplication(bobApp)!.status, 'rejected', 'reject closed the assignment');
assert.equal(getApplication(caraApp), undefined, 'cara erased');
// Cara was erased BEFORE the queue drained: nothing about her may still deliver —
// not her queued decline DM, and not the admin application card quoting her pitch.
assert.ok(
  !outbound.slice(preDrain).some((o) => /Keen to learn/.test(o.text) || o.chatId === CARA),
  'no notification about or to cara delivered after erasure',
);

assert.equal(latestSubmission(aliceApp)!.status, 'approved');
assert.equal(latestSubmission(aliceApp)!.version, 2, 'alice on v2');
assert.equal(listSubmissionVersions(aliceApp).length, 2, 'both versions retained');
assert.equal(latestSubmission(bobApp)!.status, 'rejected');

const alice = getContributor(ALICE)!;
assert.equal(alice.applied_count, 1);
assert.equal(alice.assigned_count, 0, 'completed work is no longer in progress');
assert.equal(alice.completed_count, 1);
assert.equal(getContributor(BOB)!.rejected_count, 1);
assert.equal(getContributor(CARA), undefined, 'cara profile gone');
assert.equal(listApplicationsByContributor(CARA).length, 0, 'cara applications gone');

const history = listHistory(1).map((h) => h.action);
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

console.log('\n✅ BOT DEMO PASSED — apply → assign (slots) → versioned submit → review → erasure.');
console.log(`   history: ${history.join(' → ')}`);
console.log(`   alice: applied=${alice.applied_count} assigned=${alice.assigned_count} completed=${alice.completed_count}`);
