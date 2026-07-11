/**
 * Adversarial edge suite: drives the same real Telegraf stack as demo-loop.ts
 * (middleware, per-user queue, sessions, scenes, Postgres, worker) through the
 * shared harness (scripts/harness.ts), whose transport stub throws on
 * >4096-char messages and >1024-char captions exactly like the live Bot API —
 * and aims at the seams the happy-path demos skip: Telegram size limits,
 * group-vs-private surfaces, photo albums, the /forget mid-delivery race,
 * every media send path (photo/video/video note), 429 ordering, migrations.
 * Run: npm run edge-demo (throwaway database).
 */
import assert from 'node:assert';
import { createBot } from '../src/bot/index.js';
import { drainNotifications } from '../src/bot/worker.js';
import { SCHEMA_VERSION, one } from '../src/core/db.js';
import { enqueue } from '../src/core/models/notification.js';
import { notifyApplicant, notifyAdminsOfApplication } from '../src/bot/notify.js';
import {
  getApplication,
  getApplicationFor,
  getContributor,
  getTask,
  latestSubmission,
  forgetContributor,
  notificationCounts,
} from '../src/core/service.js';
import { createHarness, step, ok } from './harness.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';

const ADMIN = Number(process.env.ADMIN_IDS!.split(',')[0]);
const ALICE = 100;
const BOB = 200;
const CARA = 300;
const DAVE = 400; // starts as a group-only bystander; later DMs and contributes
const GROUP = -100500;
const USERS = {
  [ADMIN]: { first_name: 'Ada', username: 'ada_admin' },
  [ALICE]: { first_name: 'Alice', username: 'alice' },
  [BOB]: { first_name: 'Bob', username: 'bob' },
  [CARA]: { first_name: 'Cara', username: 'cara' },
  [DAVE]: { first_name: 'Dave', username: 'dave_bystander' },
};

const bot = createBot();
const { outbound, apiErrors, onApi, since, repliesTo, say, sayIn, tap, sendPhoto, sendVideo, sendVideoNote } =
  createHarness(bot, USERS);
const groupChat = { id: GROUP, type: 'supergroup', title: 'Pilot Group' };
const sayInGroup = (userId: number, text: string) => sayIn(groupChat, userId, text);

async function main(): Promise<void> {
  await resetDb();

  // -------------------------------------------------------------------------
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
  const aliceApp = (await getApplicationFor(1, ALICE))!.id;
  await tap(ADMIN, `assign:${aliceApp}`);
  assert.equal((await getApplication(aliceApp))!.status, 'assigned');
  ok(`alice assigned (application ${aliceApp})`);

  // -------------------------------------------------------------------------
  step('1. A photo album in the submit wizard is refused, not silently halved');
  let mark = outbound.length;
  await say(ALICE, '/submit'); // single assignment → straight into the scene
  assert.ok(repliesTo(mark, ALICE).some((o) => o.text.startsWith('Submit your work')), 'submit prompt shown');

  mark = outbound.length;
  await sendPhoto(ALICE, 'PH-ALB1-A', { mediaGroupId: 'alb-1' });
  await sendPhoto(ALICE, 'PH-ALB1-B', { mediaGroupId: 'alb-1' });
  const albumWarnings = repliesTo(mark, ALICE).filter((o) => o.text.includes('Albums'));
  assert.equal(albumWarnings.length, 1, `exactly one album warning (got ${albumWarnings.length})`);
  assert.equal(await latestSubmission(aliceApp), undefined, 'no submission recorded from the album');
  assert.ok(!since(mark).some((o) => o.text.includes('Submitted')), 'no false "Submitted" confirmation');
  ok('2-photo album → one warning, zero submissions, no false confirmation');

  mark = outbound.length;
  await sendPhoto(ALICE, 'PH-ALB2-A', { mediaGroupId: 'alb-2' }); // a second, different album
  assert.equal(repliesTo(mark, ALICE).filter((o) => o.text.includes('Albums')).length, 1, 'new album → warned again');

  mark = outbound.length;
  await sendPhoto(ALICE, 'PH-FINAL', { caption: 'final screenshot' }); // single photo, no group id
  assert.ok(repliesTo(mark, ALICE).some((o) => o.text.includes('Submitted (v1)')), 'single photo accepted after album refusal');
  const aliceSub = (await latestSubmission(aliceApp))!;
  assert.equal(aliceSub.type, 'screenshot');
  assert.equal(aliceSub.content, 'PH-FINAL');
  ok('single photo then accepted as submission v1 (file_id intact)');

  // -------------------------------------------------------------------------
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
  assert.equal((await getTask(2))!.title.length, 4000, 'full title stored unclamped');

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
  const bobApp = (await getApplicationFor(2, BOB))!.id;

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

  // -------------------------------------------------------------------------
  step('3. Admin commands refuse to render contributor data in a group');
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

  // -------------------------------------------------------------------------
  step('3b. Group /open deep-links Apply into the DM (a callback would dead-end)');
  mark = outbound.length;
  await sayInGroup(CARA, '/open');
  const groupCards = repliesTo(mark, GROUP).filter((o) => o.replyMarkup);
  assert.ok(groupCards.length > 0, 'group /open rendered an applyable card');
  for (const wired of groupCards.map((o) => JSON.stringify(o.replyMarkup))) {
    assert.ok(wired.includes('https://t.me/DemoBot?start=t'), `group Apply is a deep link: ${wired}`);
    assert.ok(!wired.includes('callback_data'), 'no callback Apply button in a group');
  }
  mark = outbound.length;
  await say(CARA, '/open');
  const dmCard = repliesTo(mark, CARA).find((o) => o.replyMarkup);
  assert.ok(
    JSON.stringify(dmCard?.replyMarkup).includes('"callback_data":"apply:'),
    'private /open keeps the callback button',
  );
  mark = outbound.length;
  await say(CARA, '/start t2');
  assert.ok(repliesTo(mark, CARA).some((o) => o.text.startsWith('Applying to #2')), 'deep link opens the apply wizard');
  await say(CARA, '/cancel'); // leave no wizard state for the later steps
  mark = outbound.length;
  await tap(CARA, 'apply:2', groupChat);
  assert.ok(repliesTo(mark, GROUP).some((o) => o.text.includes('private chat')), 'stale group callback still redirected');
  ok('group /open → t.me deep link; private /open → callback; stale group taps still guarded');

  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  step('5. /forget mid-batch: claimed-but-erased rows are not delivered');
  assert.equal((await notificationCounts()).queued + (await notificationCounts()).retrying, 0, 'queue empty before the race setup');
  await say(BOB, `/submit ${bobApp}`);
  await say(BOB, 'https://example.com/bob-work'); // row 1: review alert about BOB (delivered first)
  await tap(CARA, 'apply:2');
  await say(CARA, 'CARA-SECRET-PITCH'); // row 2: admin card quoting Cara
  const caraAppRow = (await getApplicationFor(2, CARA))!; // captured before erasure for the step-5b guard test
  const caraApp = caraAppRow.id;
  await tap(ADMIN, `decline:${caraApp}`); // row 3: decline DM to Cara
  assert.ok((await notificationCounts()).queued >= 3, 'batch has at least 3 rows');

  mark = outbound.length;
  onApi.current = async (method) => {
    if (method !== 'sendMessage') return;
    onApi.current = null;
    await forgetContributor(CARA, ADMIN); // lands while row 1 is on the wire, batch already claimed
  };
  await drainNotifications(bot.telegram);
  const raceOutbound = since(mark);
  assert.ok(raceOutbound.some((o) => o.chatId === ADMIN && o.text.includes('bob-work')), 'unrelated row 1 still delivered');
  assert.ok(!raceOutbound.some((o) => o.text.includes('CARA-SECRET-PITCH')), 'admin card quoting Cara was NOT delivered');
  assert.ok(!raceOutbound.some((o) => o.chatId === CARA), 'nothing was sent to Cara after erasure');
  const postRace = await notificationCounts();
  assert.equal(postRace.queued + postRace.retrying, 0, 'queue drained cleanly (erased rows skipped, not retried)');
  assert.equal(await getContributor(CARA), undefined, 'cara fully erased');
  ok('claimed batch: row about Bob delivered; both erased Cara rows skipped');

  // -------------------------------------------------------------------------
  step("5b. Producer-side guard: a producer about an already-erased contributor enqueues nothing");
  // The step-5 race is worker-side (a queued row deleted before delivery). This
  // is the producer-side window: a notification producer runs AFTER its mutation
  // committed and released its lock, so a /forget can land first — the producer
  // must then insert NOTHING (enqueueAboutContributor's locked check), or the
  // fresh rows would escape deleteForContributor and leak purged PII. Cara is
  // erased; calling the producers with her stale in-memory application must be a
  // no-op.
  assert.equal((await notificationCounts()).queued + (await notificationCounts()).retrying, 0, 'queue empty before the guard test');
  const caraTask = await getTask(2);
  await notifyApplicant(caraAppRow, caraTask, 'assigned'); // outcome DM to Cara
  await notifyAdminsOfApplication(caraAppRow, caraTask); // admin card quoting Cara's pitch
  const afterGuard = await notificationCounts();
  assert.equal(afterGuard.queued + afterGuard.retrying, 0, 'producers about an erased contributor enqueued nothing');
  ok('post-commit producers skip a contributor erased in the window — no resurrected PII');

  // -------------------------------------------------------------------------
  step('6. No profile rows for group bystanders');
  mark = outbound.length;
  await sayInGroup(DAVE, '/open');
  assert.ok(repliesTo(mark, GROUP).length > 0, '/open still answers in the group (task-only content)');
  assert.equal(await getContributor(DAVE), undefined, 'group-only user got NO contributor row');
  await say(DAVE, '/open'); // the same user DMing the bot IS recorded
  assert.ok(await getContributor(DAVE), 'DM interaction creates the profile row');
  ok('group commands leave no profile; a DM creates one');

  // -------------------------------------------------------------------------
  step('7. /privacy transparency surface');
  mark = outbound.length;
  await say(ALICE, '/privacy');
  const privacyDm = repliesTo(mark, ALICE).find((o) => o.text.includes('stores about you'));
  assert.ok(privacyDm && privacyDm.text.includes('30 days') && privacyDm.text.includes('retention window'), 'privacy text covers notification retention + infra backup policy');
  assert.ok(privacyDm!.text.includes('live database immediately'), 'privacy text states active-data erasure is immediate');
  assert.ok(!privacyDm!.text.includes('NEAR AI'), 'AI line omitted when AI is disabled');
  mark = outbound.length;
  await sayInGroup(DAVE, '/privacy'); // static text, no PII — must work in groups too
  assert.ok(repliesTo(mark, GROUP).some((o) => o.text.includes('stores about you')), '/privacy answers in groups');
  ok('privacy text delivered in DM and group; AI line correctly absent (AI off)');

  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  step('9. /status in a group hides even the invoker’s own events');
  mark = outbound.length;
  await sayInGroup(ALICE, '/status 1');
  assert.ok(repliesTo(mark, GROUP).some((o) => o.text.includes('History')), '/status still answers in the group');
  assert.ok(!since(mark).some((o) => o.chatId === GROUP && o.text.includes('alice pitch')), 'her own pitch stays out of the group');
  mark = outbound.length;
  await say(ALICE, '/status 1'); // DM view still shows her own events
  assert.ok(repliesTo(mark, ALICE).some((o) => o.text.includes('alice pitch')), 'DM /status still shows her own applied event');
  ok('group /status = task-level only; DM /status keeps own history');

  // -------------------------------------------------------------------------
  step('10. A gallery-picked (compressed) video is accepted end-to-end');
  await tap(DAVE, 'apply:2'); // task 2 has a free slot (Bob holds 1 of 2)
  await say(DAVE, 'dave pitch');
  const daveApp = (await getApplicationFor(2, DAVE))!.id;
  await tap(ADMIN, `assign:${daveApp}`);
  await say(DAVE, `/submit ${daveApp}`);
  mark = outbound.length;
  await sendVideo(DAVE, 'VID-1', { caption: 'walkthrough video' });
  assert.ok(repliesTo(mark, DAVE).some((o) => o.text.includes('Submitted (v1)')), 'compressed video accepted, not re-prompted');
  const daveSub = (await latestSubmission(daveApp))!;
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

  // -------------------------------------------------------------------------
  step('11. An in-chat camera video note (msg.video_note) is accepted and replays via sendVideoNote');
  await tap(ADMIN, `rev:revise:${daveSub.id}`); // revise so Dave may submit a v2
  await say(ADMIN, 'Please add narration.');
  await say(DAVE, `/submit ${daveApp}`);
  mark = outbound.length;
  await sendVideoNote(DAVE, 'VNOTE-1');
  assert.ok(repliesTo(mark, DAVE).some((o) => o.text.includes('Submitted (v2)')), 'video note accepted, not re-prompted');
  const noteSub = (await latestSubmission(daveApp))!;
  assert.equal(noteSub.type, 'video_note');
  assert.equal(noteSub.content, 'VNOTE-1');
  mark = outbound.length;
  await say(ADMIN, '/review');
  assert.ok(
    since(mark).some((o) => o.method === 'sendVideoNote' && o.chatId === ADMIN && o.fileId === 'VNOTE-1'),
    'inline path replays the note via sendVideoNote (its own file_id family)',
  );
  mark = outbound.length;
  await drainNotifications(bot.telegram);
  assert.ok(
    since(mark).some((o) => o.method === 'sendVideoNote' && o.chatId === ADMIN && o.fileId === 'VNOTE-1'),
    'queued review alert replays the note via sendVideoNote',
  );
  ok('round video note → v2, replayed playable through both paths');

  // -------------------------------------------------------------------------
  step('12. A 429 mid-batch pauses delivery without reordering the queue');
  assert.equal((await notificationCounts()).queued + (await notificationCounts()).retrying, 0, 'queue empty before the ordering test');
  await enqueue({ dedupKey: 'edge:order:1', chatId: String(ALICE), subjectId: null, text: 'ORDER-1' });
  await enqueue({ dedupKey: 'edge:order:2', chatId: String(ALICE), subjectId: null, text: 'ORDER-2' });
  let flooded = false;
  onApi.current = (method, payload) => {
    if (method === 'sendMessage' && payload.text === 'ORDER-1' && !flooded) {
      flooded = true; // 429 exactly once, on the FIRST row of the batch
      throw Object.assign(new Error('429: Too Many Requests'), { parameters: { retry_after: 0.01 } });
    }
  };
  mark = outbound.length;
  await drainNotifications(bot.telegram);
  onApi.current = null;
  const order = since(mark).filter((o) => o.text.startsWith('ORDER-')).map((o) => o.text);
  assert.deepEqual(order, ['ORDER-1', 'ORDER-2'], 'flood-paused row still delivered before later rows');
  ok('429 on row 1 → batch abandoned, next pass re-claims in id order (no inversion)');

  // -------------------------------------------------------------------------
  step('13. Migrations applied and recorded in schema_migrations');
  const applied = (await one<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations'))!.v;
  assert.equal(applied, SCHEMA_VERSION, 'every migration recorded in schema_migrations');
  // App-level erasure (the promise the product controls) was verified in step 5.
  // Infrastructure backup/PITR is Railway's job, covered by the deploy docs'
  // operational restore drill — not by this in-process suite.
  ok(`schema_migrations at version ${SCHEMA_VERSION} (backup/restore is infra — see deploy docs)`);

  // -------------------------------------------------------------------------
  step('Global invariants');
  assert.equal(apiErrors.length, 0, `Telegram limit violations: ${JSON.stringify(apiErrors)}`);
  assert.equal(outbound.filter((o) => o.text.length > 4096).length, 0, 'no outbound message ever exceeded 4096 chars');
  ok(`${outbound.length} outbound API calls total — none over Telegram's limits, no swallowed 400s`);

  console.log('\n✅ EDGE DEMO PASSED — Telegram limits, group privacy, albums, erasure race, media paths, video + video note, 429 ordering, migrations.');
}

runScript(main);
