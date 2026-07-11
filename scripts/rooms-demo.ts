/**
 * Rooms & signal-detection suite: drives the same real Telegraf stack as the
 * other demos through scripts/harness.ts, plus a stubbed NEAR AI endpoint
 * (globalThis.fetch — the real OpenAI SDK client runs, so assist.ts's request
 * and parsing paths are exercised, not bypassed). Covers: the my_chat_member
 * room bootstrap, /enablesignals opt-in and gating, the signal pipeline
 * (draft / discard / prefilter / hourly budget / garbage JSON), the privacy
 * invariants (no message text, no author ids), room-admin-scoped task
 * management vs global-only commands, reply-based admin promotion, and
 * erasure of a room admin. Run: npm run rooms-demo (throwaway database).
 */
import assert from 'node:assert';
import { createBot } from '../src/bot/index.js';
import { drainNotifications } from '../src/bot/worker.js';
import { many } from '../src/core/db.js';
import {
  getTask,
  getApplicationFor,
  latestSubmission,
  getContributor,
  getRoom,
  isRoomAdmin,
  listRoomAdmins,
  listHistory,
  forgetContributor,
  claimSignalSlot,
} from '../src/core/service.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';

// ---------------------------------------------------------------------------
// Stub NEAR AI at the network boundary. aiResponder.current decides what the
// "model" says for the next call(s); aiCalls counts spend (the budget surface).
let aiCalls = 0;
const aiResponder: { current: (userText: string) => string } = {
  current: () => 'plain non-JSON model output',
};
globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
  aiCalls += 1;
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { messages?: { content?: unknown }[] }) : {};
  const userMsg = String(body.messages?.[body.messages.length - 1]?.content ?? '');
  const content = aiResponder.current(userMsg);
  return new Response(
    JSON.stringify({
      id: 'demo',
      object: 'chat.completion',
      created: 0,
      model: 'demo',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

import { createHarness, step, ok } from './harness.js';

const ADMIN = Number(process.env.ADMIN_IDS!.split(',')[0]);
const MAYA = 500; // adds the bot to the group → first room admin
const NINA = 600; // promoted (and demoted) via /addroomadmin
const OMAR = 700; // group chatter — must never be recorded anywhere
const PETE = 800; // contributor working the signal-drafted task
const ROOM = -100600;
const USERS = {
  [ADMIN]: { first_name: 'Ada', username: 'ada_admin' },
  [MAYA]: { first_name: 'Maya', username: 'maya' },
  [NINA]: { first_name: 'Nina', username: 'nina' },
  [OMAR]: { first_name: 'Omar', username: 'omar' },
  [PETE]: { first_name: 'Pete', username: 'pete' },
};

const bot = createBot();
const { outbound, apiErrors, since, repliesTo, say, sayIn, sayInReplyTo, myChatMember, tap } = createHarness(
  bot,
  USERS,
);
const groupChat = { id: ROOM, type: 'supergroup', title: 'Builders Guild' };
const inGroup = (userId: number, text: string) => sayIn(groupChat, userId, text);

const signalRows = (): Promise<{ status: string; score: number | null; task_id: number | null }[]> =>
  many<{ status: string; score: number | null; task_id: number | null }>('SELECT status, score, task_id FROM signals ORDER BY id');

async function waitFor(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

async function main(): Promise<void> {
  await resetDb();

  // -------------------------------------------------------------------------
  step('1. Bot added to a group → room registered, inviter is first room admin');
  let mark = outbound.length;
  await myChatMember(groupChat, MAYA, 'left', 'member');
  assert.ok(await getRoom(ROOM), 'room row created');
  assert.equal((await getRoom(ROOM))!.title, 'Builders Guild');
  assert.ok(await isRoomAdmin(ROOM, MAYA), 'inviter became the first room admin');
  await drainNotifications(bot.telegram);
  const addedAlert = repliesTo(mark, ADMIN).find((o) => o.text.includes('added to the group'));
  assert.ok(addedAlert && addedAlert.text.includes('Builders Guild') && addedAlert.text.includes(String(MAYA)), 'global admin told, with room + inviter');
  ok('room bootstrapped; global admin alerted through the queue');

  // -------------------------------------------------------------------------
  step('2. /enablesignals is room-admin-gated and announces the scanning publicly');
  mark = outbound.length;
  await inGroup(OMAR, '/enablesignals');
  assert.ok(repliesTo(mark, ROOM).some((o) => o.text.includes('room’s admins')), 'non-admin refused');
  assert.equal((await getRoom(ROOM))!.signals_enabled, 0, 'still off');
  mark = outbound.length;
  await inGroup(MAYA, '/enablesignals');
  const enabledNotice = repliesTo(mark, ROOM).find((o) => o.text.includes('Signal detection is ON'));
  assert.ok(enabledNotice && enabledNotice.text.includes('not stored'), 'public notice names the scanning and the no-storage rule');
  assert.equal((await getRoom(ROOM))!.signals_enabled, 1, 'enabled');
  mark = outbound.length;
  await inGroup(OMAR, '/signalstatus');
  assert.ok(repliesTo(mark, ROOM).some((o) => o.text.includes('ON')), '/signalstatus answers any member');
  ok('gating + transparency notice + /signalstatus');

  // -------------------------------------------------------------------------
  step('3. A promising message auto-drafts a task (Draft — humans still approve)');
  aiResponder.current = () =>
    JSON.stringify({
      score: 8,
      shouldDraft: true,
      title: 'Translate the docs to Spanish',
      description: 'Community needs the onboarding docs in Spanish before the meetup.',
      requiredOutput: 'A PR with the translated docs',
    });
  mark = outbound.length;
  await inGroup(OMAR, 'we really need someone to translate the onboarding docs to Spanish before the meetup next week');
  // Wait for the manager NOTIFICATIONS, not just the task: the detached
  // evaluate() commits the task and enqueues the alerts in separate awaits, so
  // draining after only the task appears races the enqueue (async pg — the
  // production worker just picks the rows up on its next tick).
  await waitFor(
    async () => (await many("SELECT 1 FROM notifications WHERE dedup_key LIKE 'signal-draft:%'")).length >= 2,
    'signal-draft alerts enqueued for both managers',
  );
  const drafted = (await getTask(1))!;
  assert.equal(drafted.status, 'draft', 'drafted, NOT opened — AI never opens a task');
  assert.equal(drafted.room_chat_id, ROOM, 'task belongs to the room');
  assert.equal(drafted.created_by, null, 'no author recorded on the task');
  assert.equal(drafted.title, 'Translate the docs to Spanish');
  const created = (await listHistory(1)).find((e) => e.action === 'created')!;
  assert.equal(created.actor_id, null, 'history names no actor');
  assert.ok(created.detail!.includes('score 8'), 'history carries the score, nothing personal');
  assert.deepEqual(await signalRows(), [{ status: 'drafted', score: 8, task_id: 1 }], 'signal row: outcome only');
  await drainNotifications(bot.telegram);
  for (const managerId of [ADMIN, MAYA]) {
    assert.ok(
      repliesTo(mark, managerId).some((o) => o.text.includes('Signal detection drafted') && o.text.includes('Builders Guild')),
      `manager ${managerId} was told about the draft`,
    );
  }
  ok('draft created, room-linked, authorless; both managers notified');

  // -------------------------------------------------------------------------
  step('4. Privacy invariants: no message text, no author, no bystander profiles');
  const signalCols = (
    await many<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signals'",
    )
  )
    .map((c) => c.column_name)
    .sort();
  assert.deepEqual(
    signalCols,
    ['created_at', 'id', 'room_chat_id', 'score', 'status', 'task_id', 'updated_at'],
    'signals table has no column that could hold text or an author id',
  );
  assert.equal(await getContributor(OMAR), undefined, 'group chatter got no contributor row');
  ok('schema-level: nothing to leak; Omar never recorded');

  // -------------------------------------------------------------------------
  step('5. Prefilter, low score, garbage JSON, and the hourly budget');
  let calls = aiCalls;
  await inGroup(OMAR, 'ok'); // too short — no API spend
  assert.equal(aiCalls, calls, 'prefiltered message costs nothing');
  assert.equal((await signalRows()).length, 1, 'no signal row claimed');

  aiResponder.current = () => JSON.stringify({ score: 3, shouldDraft: false, title: null, description: null, requiredOutput: null });
  await inGroup(OMAR, 'lunch was pretty good today at the office, would recommend the noodles');
  await waitFor(async () => {
    const r = await signalRows();
    return r.length === 2 && r[1].status !== 'evaluating';
  }, 'discard settled');
  assert.deepEqual((await signalRows())[1], { status: 'discarded', score: 3, task_id: null }, 'low score → discarded, no task');

  aiResponder.current = () => 'sorry, as an AI model I cannot produce JSON today';
  await inGroup(OMAR, 'someone should really organize a hackathon for the new contributors soon');
  await waitFor(async () => {
    const r = await signalRows();
    return r.length === 3 && r[2].status !== 'evaluating';
  }, 'garbage settled');
  assert.deepEqual((await signalRows())[2], { status: 'discarded', score: null, task_id: null }, 'unparseable reply → discarded, no crash');
  assert.equal(await getTask(2), undefined, 'still exactly one task');

  // SIGNAL_MAX_PER_HOUR=3 (script env): the three evaluations above spent the room's hour.
  calls = aiCalls;
  await inGroup(OMAR, 'we need a designer for the new landing page, paid work, deadline friday');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(aiCalls, calls, 'over-budget message never reaches the model');
  assert.equal((await signalRows()).length, 3, 'no slot claimed past the budget');
  ok('prefilter free; discard + garbage safe; budget airtight at 3/hour');

  // -------------------------------------------------------------------------
  step('6. The room admin (not in ADMIN_IDS) runs the whole loop on the drafted task');
  mark = outbound.length;
  await say(NINA, '/approve');
  assert.ok(repliesTo(mark, NINA).some((o) => o.text === 'Admins only.'), 'a random user is still refused');
  mark = outbound.length;
  await say(MAYA, '/approve');
  assert.ok(repliesTo(mark, MAYA).some((o) => o.text.includes('Translate the docs')), 'room admin sees her room’s draft');
  await tap(MAYA, 'approve:1');
  assert.equal((await getTask(1))!.status, 'open', 'room admin approved → open');

  await say(PETE, '/open');
  await tap(PETE, 'apply:1');
  await say(PETE, 'hablo español');
  const peteApp = (await getApplicationFor(1, PETE))!.id;
  mark = outbound.length;
  await drainNotifications(bot.telegram);
  assert.ok(repliesTo(mark, MAYA).some((o) => o.text.includes('hablo español')), 'application card fanned out to the room admin');
  await tap(MAYA, `assign:${peteApp}`);
  await say(PETE, '/submit');
  await say(PETE, 'https://example.com/docs-es');
  const peteSub = (await latestSubmission(peteApp))!;
  mark = outbound.length;
  await say(MAYA, '/review');
  assert.ok(repliesTo(mark, MAYA).some((o) => o.text.includes('docs-es')), 'room admin sees the submission');
  await tap(MAYA, `rev:approve:${peteSub.id}`);
  mark = outbound.length;
  await drainNotifications(bot.telegram);
  assert.ok(repliesTo(mark, PETE).some((o) => o.text.includes('approved')), 'contributor DM’d the approval');
  assert.equal((await getApplicationFor(1, PETE))!.status, 'completed');
  ok('approve → applicants → assign → review, all as a room admin');

  // -------------------------------------------------------------------------
  step('7. Room scope ends at the room: DM tasks and global commands stay closed');
  await say(ADMIN, '/newtask');
  await say(ADMIN, 'DM-only task');
  await say(ADMIN, 'Created privately, belongs to no room.');
  await say(ADMIN, '-');
  await say(ADMIN, '-');
  await say(ADMIN, '-');
  await say(ADMIN, '1');
  const dmTask = (await getTask(2))!;
  assert.equal(dmTask.room_chat_id, null);

  mark = outbound.length;
  await say(MAYA, '/applicants 2');
  assert.ok(repliesTo(mark, MAYA).some((o) => o.text.includes('not found (or not yours to manage)')), 'foreign task reads like missing');
  mark = outbound.length;
  await say(MAYA, '/close 2');
  assert.ok(repliesTo(mark, MAYA).some((o) => o.text.includes('not yours to manage')), '/close gated');
  mark = outbound.length;
  await tap(MAYA, 'approve:2');
  assert.ok(since(mark).some((o) => o.method === 'answerCallbackQuery' && o.text === 'Admins only.'), 'approve button on a DM task refused');
  assert.equal((await getTask(2))!.status, 'draft', 'DM task untouched');
  mark = outbound.length;
  await say(MAYA, '/approve');
  assert.ok(repliesTo(mark, MAYA).some((o) => o.text === 'No draft tasks awaiting approval.'), 'her /approve list excludes the DM draft');
  for (const cmd of ['/newtask', '/admin', `/forget ${OMAR}`]) {
    mark = outbound.length;
    await say(MAYA, cmd);
    assert.ok(repliesTo(mark, MAYA).some((o) => o.text === 'Admins only.'), `${cmd} stays global-only`);
  }
  ok('room admin sees nothing outside her room; global commands refused');

  // -------------------------------------------------------------------------
  step('8. /addroomadmin by reply; /roomadmins; /removeroomadmin');
  mark = outbound.length;
  await inGroup(MAYA, '/addroomadmin'); // no reply target
  assert.ok(repliesTo(mark, ROOM).some((o) => o.text.includes('Reply to a message')), 'usage without a reply');
  await sayInReplyTo(groupChat, MAYA, '/addroomadmin', NINA);
  assert.ok(await isRoomAdmin(ROOM, NINA), 'Nina promoted');
  mark = outbound.length;
  await drainNotifications(bot.telegram);
  assert.ok(repliesTo(mark, NINA).some((o) => o.text.includes('room admin')), 'Nina DM’d her promotion');
  mark = outbound.length;
  await inGroup(OMAR, '/roomadmins');
  const roster = repliesTo(mark, ROOM).find((o) => o.text.includes('Room admins'));
  // Both have contributor rows (each DM'd the bot earlier), so both show by @username.
  assert.ok(roster && roster.text.includes('@maya') && roster.text.includes('@nina'), 'roster lists both admins');
  mark = outbound.length;
  await say(NINA, '/approve');
  assert.ok(repliesTo(mark, NINA).some((o) => o.text === 'No draft tasks awaiting approval.'), 'Nina now has room-admin access');
  await sayInReplyTo(groupChat, MAYA, '/removeroomadmin', NINA);
  assert.ok(!(await isRoomAdmin(ROOM, NINA)), 'Nina demoted');
  mark = outbound.length;
  await say(NINA, '/approve');
  assert.ok(repliesTo(mark, NINA).some((o) => o.text === 'Admins only.'), 'and refused again');
  ok('promotion by reply, roster, demotion — with the DM notice');

  // -------------------------------------------------------------------------
  step('9. /disablesignals stops the listener; room commands are group-only');
  await inGroup(MAYA, '/disablesignals');
  assert.equal((await getRoom(ROOM))!.signals_enabled, 0);
  calls = aiCalls;
  const rows = (await signalRows()).length;
  await inGroup(OMAR, 'huge opportunity: we need a whole team for the conference booth next month');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(aiCalls, calls, 'disabled room never reaches the model');
  assert.equal((await signalRows()).length, rows, 'and claims no slot');
  // The race the handler's unlocked opt-in check can't cover: signals were ON
  // when handleGroupMessage read the room, then /disablesignals committed before
  // the slot claim. claimSignalSlot re-reads signals_enabled UNDER the room lock
  // and bails — no slot, no AI spend on an opted-out room.
  assert.equal(await claimSignalSlot(ROOM, 100), null, 'claimSignalSlot re-checks signals_enabled under the lock');
  assert.equal((await signalRows()).length, rows, 'the raced claim created no evaluating row');
  mark = outbound.length;
  await say(MAYA, '/enablesignals');
  assert.ok(repliesTo(mark, MAYA).some((o) => o.text.includes('inside a group')), 'room commands refuse DMs');
  ok('off means off; group-only commands redirect in DM');

  // -------------------------------------------------------------------------
  step('10. Bot kicked → signals forced off; erasing a room admin clears her rows');
  await inGroup(MAYA, '/enablesignals');
  assert.equal((await getRoom(ROOM))!.signals_enabled, 1);
  await myChatMember(groupChat, OMAR, 'member', 'kicked');
  assert.equal((await getRoom(ROOM))!.signals_enabled, 0, 'kick switches scanning off');
  assert.ok(await isRoomAdmin(ROOM, MAYA), 'admins survive the kick (restored on re-add)');

  assert.ok(await getContributor(MAYA), 'Maya became a contributor by DMing the bot');
  await forgetContributor(MAYA, ADMIN);
  assert.equal(await getContributor(MAYA), undefined, 'profile gone');
  assert.ok(!(await isRoomAdmin(ROOM, MAYA)), 'room-admin membership erased with her');
  assert.equal((await listRoomAdmins(ROOM)).length, 0, 'no orphaned admin rows');
  ok('kick handling + erasure covers room_admins');

  // -------------------------------------------------------------------------
  step('11. /forget erases a room admin who NEVER DM’d the bot (no profile row)');
  // Omar has no contributors row (standing invariant of this suite) — after a
  // group-side promotion, his room_admins row and the queued promotion DM are
  // his entire footprint, and /forget must erase exactly that.
  await sayInReplyTo(groupChat, ADMIN, '/addroomadmin', OMAR);
  assert.ok(await isRoomAdmin(ROOM, OMAR), 'Omar promoted without ever DMing the bot');
  assert.equal(await getContributor(OMAR), undefined, 'still no profile row');
  mark = outbound.length;
  await say(ADMIN, `/forget ${OMAR}`);
  assert.ok(repliesTo(mark, ADMIN).some((o) => o.text.includes('Erased contributor')), 'erasure reported as done');
  assert.ok(!(await isRoomAdmin(ROOM, OMAR)), 'his room-admin row is gone');
  mark = outbound.length;
  await say(ADMIN, '/forget 999999');
  assert.ok(
    repliesTo(mark, ADMIN).some((o) => o.text.includes('not found — nothing was erased')),
    'an id matching nothing still fails loudly',
  );
  ok('profile-less room admin erasable; typo’d ids still refused');

  // -------------------------------------------------------------------------
  step('Global invariants');
  assert.equal(apiErrors.length, 0, `Telegram limit violations: ${JSON.stringify(apiErrors)}`);
  assert.equal(outbound.filter((o) => o.text.length > 4096).length, 0, 'no outbound message over 4096 chars');
  const groupTexts = outbound.filter((o) => o.chatId === ROOM).map((o) => o.text);
  assert.ok(!groupTexts.some((t) => t.includes('hablo español') || t.includes('docs-es')), 'no contributor data ever landed in the group');
  ok(`${outbound.length} outbound API calls, ${aiCalls} AI calls — limits respected, group stayed clean`);

  console.log('\n✅ ROOMS DEMO PASSED — bootstrap, signal pipeline, privacy invariants, room-scoped admin, promotion/demotion, erasure.');
}

runScript(main);
