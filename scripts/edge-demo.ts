/**
 * Adversarial edge suite: drives the same real Telegraf stack as demo-loop.ts
 * (middleware, per-user queue, sessions, scenes, SQLite, worker) but with a
 * STRICTER transport stub — it throws on >4096-char messages and >1024-char
 * captions exactly like the live Bot API — and aims at the seams the happy-path
 * demos skip: Telegram size limits, group-vs-private surfaces, photo albums,
 * the /forget mid-delivery race, both media send paths, migrations, backups.
 * Run: npm run edge-demo (throwaway database).
 */
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Telegram } from 'telegraf';
import { createBot } from '../src/bot/index.js';
import { drainNotifications } from '../src/bot/worker.js';
import { db, backupDb } from '../src/core/db.js';
import {
  getApplication,
  getApplicationFor,
  getContributor,
  getTask,
  latestSubmission,
  forgetContributor,
  notificationCounts,
} from '../src/core/service.js';

const ADMIN = Number(process.env.ADMIN_IDS!.split(',')[0]);
const ALICE = 100;
const BOB = 200;
const CARA = 300;
const DAVE = 400; // only ever speaks in the group — must never get a profile row
const GROUP = -100500;
const USERS: Record<number, { first_name: string; username: string }> = {
  [ADMIN]: { first_name: 'Ada', username: 'ada_admin' },
  [ALICE]: { first_name: 'Alice', username: 'alice' },
  [BOB]: { first_name: 'Bob', username: 'bob' },
  [CARA]: { first_name: 'Cara', username: 'cara' },
  [DAVE]: { first_name: 'Dave', username: 'dave_bystander' },
};

const bot = createBot();
bot.botInfo = { id: 999, is_bot: true, first_name: 'Edge', username: 'DemoBot' } as never;

interface Outbound { method: string; chatId: number | string | undefined; text: string; fileId?: string }
const outbound: Outbound[] = [];
const apiErrors: string[] = [];
let msgId = 5000;

// Armed by the /forget race phase: fires once, inside the first queued send.
let onFirstQueuedSend: (() => void) | null = null;

(Telegram.prototype as unknown as { callApi: (m: string, p: Record<string, unknown>) => Promise<unknown> }).callApi =
  async (method, payload) => {
    const text = typeof payload.text === 'string' ? payload.text : undefined;
    const caption = typeof payload.caption === 'string' ? payload.caption : undefined;
    // Enforce the real Bot API's limits: an oversized message must FAIL here,
    // exactly as it would in production, or this suite can't catch regressions.
    if (text !== undefined && text.length > 4096) {
      apiErrors.push(`${method}: message is too long (${text.length})`);
      throw new Error('400: Bad Request: message is too long');
    }
    if (caption !== undefined && caption.length > 1024) {
      apiErrors.push(`${method}: caption is too long (${caption.length})`);
      throw new Error('400: Bad Request: message caption is too long');
    }
    if (onFirstQueuedSend && method === 'sendMessage') {
      const hook = onFirstQueuedSend;
      onFirstQueuedSend = null;
      hook(); // simulates /forget landing while this send is on the wire
    }
    const fileId = (payload.photo ?? payload.document ?? payload.video) as string | undefined;
    outbound.push({ method, chatId: payload.chat_id as number | string | undefined, text: text ?? caption ?? '', fileId });
    if (method === 'answerCallbackQuery' || method === 'answerCbQuery') return true;
    if (method === 'editMessageText') return true;
    return { message_id: msgId++, chat: { id: payload.chat_id ?? 0 }, date: 0, text: text ?? '' };
  };

let updateId = 1;
const from = (id: number) => ({ id, is_bot: false, ...USERS[id] });
const privateChat = (id: number) => ({ id, type: 'private', first_name: USERS[id].first_name });
const groupChat = { id: GROUP, type: 'supergroup', title: 'Pilot Group' };

async function send(userId: number, text: string, chat: Record<string, unknown>) {
  const entities = text.startsWith('/')
    ? [{ offset: 0, length: text.split(/[\s@]/)[0].length, type: 'bot_command' }]
    : undefined;
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: msgId++, from: from(userId), chat, date: 0, text, ...(entities ? { entities } : {}) },
  } as never);
}
const say = (userId: number, text: string) => send(userId, text, privateChat(userId));
const sayInGroup = (userId: number, text: string) => send(userId, text, groupChat);

async function sendPhoto(userId: number, fileId: string, opts: { mediaGroupId?: string; caption?: string } = {}) {
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: msgId++,
      from: from(userId),
      chat: privateChat(userId),
      date: 0,
      photo: [{ file_id: `${fileId}-small`, width: 90, height: 90 }, { file_id: fileId, width: 800, height: 600 }],
      ...(opts.mediaGroupId ? { media_group_id: opts.mediaGroupId } : {}),
      ...(opts.caption ? { caption: opts.caption } : {}),
    },
  } as never);
}

/** A gallery-picked video: Telegram sends msg.video (compressed), NOT msg.document. */
async function sendVideoMsg(userId: number, fileId: string, opts: { caption?: string } = {}) {
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: msgId++,
      from: from(userId),
      chat: privateChat(userId),
      date: 0,
      video: { file_id: fileId, width: 1280, height: 720, duration: 30 },
      ...(opts.caption ? { caption: opts.caption } : {}),
    },
  } as never);
}

async function tap(userId: number, data: string) {
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      from: from(userId),
      chat_instance: 'edge',
      data,
      message: { message_id: msgId++, from: { id: 999, is_bot: true, first_name: 'Edge' }, chat: privateChat(userId), date: 0, text: 'card' },
    },
  } as never);
}

const since = (mark: number) => outbound.slice(mark);
const repliesTo = (mark: number, chatId: number | string) => since(mark).filter((o) => o.chatId === chatId && o.text);
const step = (t: string) => console.log(`\n▶ ${t}`);
const ok = (t: string) => console.log(`  ✅ ${t}`);

// ---------------------------------------------------------------------------
step('Setup: task #1 (normal title), Alice applies, admin assigns her');
await say(ADMIN, '/newtask');
await say(ADMIN, 'Ship the pilot');
await say(ADMIN, 'Get the pilot group live.');
await say(ADMIN, '50 USDC');
await say(ADMIN, '-');
await say(ADMIN, '-');
await say(ADMIN, '1');
await say(ADMIN, '/approve');
await tap(ADMIN, 'approve:1');
await tap(ALICE, 'apply:1');
await say(ALICE, 'alice pitch');
const aliceApp = getApplicationFor(1, ALICE)!.id;
await tap(ADMIN, `assign:${aliceApp}`);
assert.equal(getApplication(aliceApp)!.status, 'assigned');
ok(`alice assigned (application ${aliceApp})`);

// ---------------------------------------------------------------------------
step('1. A photo album in the submit wizard is refused, not silently halved');
let mark = outbound.length;
await say(ALICE, '/submit'); // single assignment → straight into the scene
assert.ok(repliesTo(mark, ALICE).some((o) => o.text.startsWith('Submit your work')), 'submit prompt shown');

mark = outbound.length;
await sendPhoto(ALICE, 'PH-ALB1-A', { mediaGroupId: 'alb-1' });
await sendPhoto(ALICE, 'PH-ALB1-B', { mediaGroupId: 'alb-1' });
const albumWarnings = repliesTo(mark, ALICE).filter((o) => o.text.includes('Albums'));
assert.equal(albumWarnings.length, 1, `exactly one album warning (got ${albumWarnings.length})`);
assert.equal(latestSubmission(aliceApp), undefined, 'no submission recorded from the album');
assert.ok(!since(mark).some((o) => o.text.includes('Submitted')), 'no false "Submitted" confirmation');
ok('2-photo album → one warning, zero submissions, no false confirmation');

mark = outbound.length;
await sendPhoto(ALICE, 'PH-ALB2-A', { mediaGroupId: 'alb-2' }); // a second, different album
assert.equal(repliesTo(mark, ALICE).filter((o) => o.text.includes('Albums')).length, 1, 'new album → warned again');

mark = outbound.length;
await sendPhoto(ALICE, 'PH-FINAL', { caption: 'final screenshot' }); // single photo, no group id
assert.ok(repliesTo(mark, ALICE).some((o) => o.text.includes('Submitted (v1)')), 'single photo accepted after album refusal');
const aliceSub = latestSubmission(aliceApp)!;
assert.equal(aliceSub.type, 'screenshot');
assert.equal(aliceSub.content, 'PH-FINAL');
ok('single photo then accepted as submission v1 (file_id intact)');

// ---------------------------------------------------------------------------
step('2. A 4000-char task title survives apply / applicants / submit prompts');
const BIG_TITLE = 'T'.repeat(4000);
await say(ADMIN, '/newtask');
await say(ADMIN, BIG_TITLE);
await say(ADMIN, 'Long-title task.');
await say(ADMIN, '-');
await say(ADMIN, '-');
await say(ADMIN, '-');
await say(ADMIN, '2');
await say(ADMIN, '/approve');
await tap(ADMIN, 'approve:2');
assert.equal(getTask(2)!.title.length, 4000, 'full title stored unclamped');

mark = outbound.length;
await tap(BOB, 'apply:2'); // unclamped, this reply would exceed 4096 and trap Bob in the scene
const applyPrompt = repliesTo(mark, BOB).find((o) => o.text.startsWith('Applying to #2'));
assert.ok(applyPrompt, 'apply prompt was actually delivered');
assert.ok(applyPrompt!.text.length <= 4096 && applyPrompt!.text.includes('…'), 'title clamped in prompt');
mark = outbound.length;
await say(BOB, '/cancel'); // the historical failure mode left the user trapped here
assert.ok(repliesTo(mark, BOB).some((o) => o.text === 'Cancelled.'), '/cancel works inside the wizard');
ok(`apply prompt delivered (${applyPrompt!.text.length} chars) and /cancel exits — no trap`);

await tap(BOB, 'apply:2');
await say(BOB, 'bob pitch');
const bobApp = getApplicationFor(2, BOB)!.id;

mark = outbound.length;
await say(ADMIN, '/applicants 2');
const header = repliesTo(mark, ADMIN).find((o) => o.text.startsWith('👥 Task #2'));
const bobCard = repliesTo(mark, ADMIN).find((o) => o.text.includes('bob pitch'));
assert.ok(header && header.text.length <= 4096, 'applicants header delivered and clamped');
assert.ok(bobCard, 'applicant card rendered after the header (command completed)');
ok(`/applicants header ${header!.text.length} chars + bob's card delivered`);

await tap(ADMIN, `assign:${bobApp}`);
mark = outbound.length;
await say(BOB, `/submit ${bobApp}`);
const subPrompt = repliesTo(mark, BOB).find((o) => o.text.startsWith('Submit your work'));
assert.ok(subPrompt && subPrompt.text.length <= 4096 && subPrompt.text.includes('…'), 'submit prompt delivered, clamped');
mark = outbound.length;
await say(BOB, '/cancel');
assert.ok(repliesTo(mark, BOB).some((o) => o.text === 'Cancelled.'), '/cancel exits the submit wizard');
ok(`submit prompt delivered (${subPrompt!.text.length} chars) and /cancel exits — no trap`);

// ---------------------------------------------------------------------------
step('3. Admin commands refuse to render contributor data in a group');
// Alice's screenshot submission is awaiting review — real PII behind /review.
for (const cmd of ['/review', '/applicants 2', '/active', '/forget 300', '/status 1']) {
  mark = outbound.length;
  await sayInGroup(ADMIN, cmd);
  const groupMsgs = repliesTo(mark, GROUP);
  const gated = cmd === '/status 1' // /status is public: must still answer in groups, but member-filtered
    ? groupMsgs.length > 0 && groupMsgs.some((o) => o.text.includes('History'))
    : groupMsgs.length === 1 && groupMsgs[0].text.includes('private chat');
  assert.ok(gated, `${cmd} in group → ${JSON.stringify(groupMsgs.map((o) => o.text.slice(0, 60)))}`);
  assert.ok(
    !since(mark).some((o) => o.chatId === GROUP && (o.fileId || o.text.includes('Submission v') || o.text.includes('pitch') || o.text.includes('user 1'))),
    `${cmd}: no contributor data reached the group`,
  );
}
mark = outbound.length;
await sayInGroup(ADMIN, '/review@DemoBot'); // the group-suffixed command form
assert.ok(repliesTo(mark, GROUP).some((o) => o.text.includes('private chat')), '/review@DemoBot also gated');
mark = outbound.length;
await sayInGroup(BOB, '/review'); // non-admin in group keeps the old refusal
assert.ok(repliesTo(mark, GROUP).some((o) => o.text === 'Admins only.'), 'non-admin still gets "Admins only."');
ok('admin commands in group → only the private-chat notice; zero PII, zero attachments');

// ---------------------------------------------------------------------------
step('4. /review attachment arrives via BOTH media paths (inline + queue)');
mark = outbound.length;
await say(ADMIN, '/review');
const inlinePhoto = since(mark).find((o) => o.method === 'sendPhoto' && o.chatId === ADMIN);
assert.ok(inlinePhoto && inlinePhoto.fileId === 'PH-FINAL', 'raw screenshot re-sent to the reviewer');
assert.ok(inlinePhoto!.text.includes('Submission v1') && inlinePhoto!.text.includes('final screenshot'), 'caption carries version + user caption');

mark = outbound.length;
await drainNotifications(bot.telegram);
const queuedPhoto = since(mark).find((o) => o.method === 'sendPhoto' && o.chatId === ADMIN && o.fileId === 'PH-FINAL');
assert.ok(queuedPhoto, 'worker delivered the media notification through sendMedia');
ok('same file_id + caption via the inline path and the queue worker');

// ---------------------------------------------------------------------------
step('5. /forget mid-batch: claimed-but-erased rows are not delivered');
assert.equal(notificationCounts().queued + notificationCounts().retrying, 0, 'queue empty before the race setup');
await say(BOB, `/submit ${bobApp}`);
await say(BOB, 'https://example.com/bob-work'); // row 1: review alert about BOB (delivered first)
await tap(CARA, 'apply:2');
await say(CARA, 'CARA-SECRET-PITCH'); // row 2: admin card quoting Cara
const caraApp = getApplicationFor(2, CARA)!.id;
await tap(ADMIN, `decline:${caraApp}`); // row 3: decline DM to Cara
assert.ok(notificationCounts().queued >= 3, 'batch has at least 3 rows');

mark = outbound.length;
onFirstQueuedSend = () => forgetContributor(CARA, ADMIN); // lands while row 1 is on the wire, batch already claimed
await drainNotifications(bot.telegram);
const raceOutbound = since(mark);
assert.ok(raceOutbound.some((o) => o.chatId === ADMIN && o.text.includes('bob-work')), 'unrelated row 1 still delivered');
assert.ok(!raceOutbound.some((o) => o.text.includes('CARA-SECRET-PITCH')), 'admin card quoting Cara was NOT delivered');
assert.ok(!raceOutbound.some((o) => o.chatId === CARA), 'nothing was sent to Cara after erasure');
const postRace = notificationCounts();
assert.equal(postRace.queued + postRace.retrying, 0, 'queue drained cleanly (erased rows skipped, not retried)');
assert.equal(getContributor(CARA), undefined, 'cara fully erased');
ok('claimed batch: row about Bob delivered; both erased Cara rows skipped');

// ---------------------------------------------------------------------------
step('6. No profile rows for group bystanders');
mark = outbound.length;
await sayInGroup(DAVE, '/open');
assert.ok(repliesTo(mark, GROUP).length > 0, '/open still answers in the group (task-only content)');
assert.equal(getContributor(DAVE), undefined, 'group-only user got NO contributor row');
await say(DAVE, '/open'); // the same user DMing the bot IS recorded
assert.ok(getContributor(DAVE), 'DM interaction creates the profile row');
ok('group commands leave no profile; a DM creates one');

// ---------------------------------------------------------------------------
step('7. /privacy transparency surface');
mark = outbound.length;
await say(ALICE, '/privacy');
const privacyDm = repliesTo(mark, ALICE).find((o) => o.text.includes('stores about you'));
assert.ok(privacyDm && privacyDm.text.includes('30 days') && privacyDm.text.includes('backups rotate within 7 days'), 'privacy text covers retention + backups');
assert.ok(!privacyDm!.text.includes('NEAR AI'), 'AI line omitted when AI is disabled');
mark = outbound.length;
await sayInGroup(DAVE, '/privacy'); // static text, no PII — must work in groups too
assert.ok(repliesTo(mark, GROUP).some((o) => o.text.includes('stores about you')), '/privacy answers in groups');
ok('privacy text delivered in DM and group; AI line correctly absent (AI off)');

// ---------------------------------------------------------------------------
step('8. Personal-data commands are DM-only');
for (const cmd of ['/myapps', '/submit', '/withdraw 1', '/notify on']) {
  mark = outbound.length;
  await sayInGroup(ALICE, cmd);
  const msgs = repliesTo(mark, GROUP);
  assert.ok(msgs.length === 1 && msgs[0].text.includes('personal data'), `${cmd} gated in group`);
}
mark = outbound.length;
await say(ALICE, '/myapps'); // same command still works in DM
assert.ok(repliesTo(mark, ALICE).some((o) => o.text.includes('#1')), '/myapps works in DM');
ok('/myapps, /submit, /withdraw, /notify → notice-only in groups, functional in DM');

// ---------------------------------------------------------------------------
step('9. /status in a group hides even the invoker’s own events');
mark = outbound.length;
await sayInGroup(ALICE, '/status 1');
assert.ok(repliesTo(mark, GROUP).some((o) => o.text.includes('History')), '/status still answers in the group');
assert.ok(!since(mark).some((o) => o.chatId === GROUP && o.text.includes('alice pitch')), 'her own pitch stays out of the group');
mark = outbound.length;
await say(ALICE, '/status 1'); // DM view still shows her own events
assert.ok(repliesTo(mark, ALICE).some((o) => o.text.includes('alice pitch')), 'DM /status still shows her own applied event');
ok('group /status = task-level only; DM /status keeps own history');

// ---------------------------------------------------------------------------
step('10. A gallery-picked (compressed) video is accepted end-to-end');
await tap(DAVE, 'apply:2'); // task 2 has a free slot (Bob holds 1 of 2)
await say(DAVE, 'dave pitch');
const daveApp = getApplicationFor(2, DAVE)!.id;
await tap(ADMIN, `assign:${daveApp}`);
await say(DAVE, `/submit ${daveApp}`);
mark = outbound.length;
await sendVideoMsg(DAVE, 'VID-1', { caption: 'walkthrough video' });
assert.ok(repliesTo(mark, DAVE).some((o) => o.text.includes('Submitted (v1)')), 'compressed video accepted, not re-prompted');
const daveSub = latestSubmission(daveApp)!;
assert.equal(daveSub.type, 'video');
assert.equal(daveSub.content, 'VID-1');
ok('msg.video recorded as a video submission (file_id intact)');

mark = outbound.length;
await say(ADMIN, '/review');
const inlineVideo = since(mark).find((o) => o.method === 'sendVideo' && o.chatId === ADMIN);
assert.ok(inlineVideo && inlineVideo.fileId === 'VID-1', 'raw video re-sent to the reviewer via sendVideo');
assert.ok(since(mark).some((o) => o.chatId === ADMIN && o.text.includes('video attachment')), 'review card names the video attachment');
mark = outbound.length;
await drainNotifications(bot.telegram);
assert.ok(
  since(mark).some((o) => o.method === 'sendVideo' && o.chatId === ADMIN && o.fileId === 'VID-1'),
  'queued review alert delivers the video through the worker',
);
ok('inline and queued paths both re-send the video playable (sendVideo, not sendDocument)');

// ---------------------------------------------------------------------------
step('11. Migrations applied; daily backup produces a restorable file');
assert.equal(db.pragma('user_version', { simple: true }), 1, 'migration 1 recorded in user_version');
const backupFile = await backupDb();
assert.ok(existsSync(backupFile), `backup file exists: ${backupFile}`);
const backup = new Database(backupFile, { readonly: true });
const backedUpTasks = (backup.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
backup.close();
assert.equal(backedUpTasks, 2, 'backup opens as a valid database with both tasks');
ok(`user_version=1; ${backupFile.split('/').pop()} written and readable (${backedUpTasks} tasks)`);

// ---------------------------------------------------------------------------
step('Global invariants');
assert.equal(apiErrors.length, 0, `Telegram limit violations: ${JSON.stringify(apiErrors)}`);
assert.equal(outbound.filter((o) => o.text.length > 4096).length, 0, 'no outbound message ever exceeded 4096 chars');
ok(`${outbound.length} outbound API calls total — none over Telegram's limits, no swallowed 400s`);

console.log('\n✅ EDGE DEMO PASSED — Telegram limits, group privacy, albums, erasure race, media paths, video, migrations, backups.');
