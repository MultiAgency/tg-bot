/**
 * Core-model demo: exercises the apply → assign → submit (versioned) → review
 * flow through the service layer directly (no Telegram). Run: npm run core-demo.
 */
import assert from 'node:assert';
import {
  createTask,
  approveTask,
  closeTask,
  apply,
  assignApplication,
  declineApplication,
  unassignApplication,
  withdrawApplication,
  submitWork,
  reviewSubmission,
  getTask,
  getApplication,
  listApplicantsAwaiting,
  listAssigned,
  countSlotsTaken,
  latestSubmission,
  listSubmissionVersions,
  getContributor,
  upsertContributor,
  forgetContributor,
  setAnnounceOptIn,
  listAnnounceRecipients,
  listApplicationsByContributor,
  listHistory,
  WorkflowError,
} from '../src/core/service.js';
import { enqueue, findByDedup, markSent } from '../src/core/models/notification.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';

const ADMIN = 1;
const ALICE = 100;
const BOB = 200;
const CARA = 300;

async function main(): Promise<void> {
  await resetDb();

  await upsertContributor(ALICE, 'alice', 'Alice');
  await upsertContributor(BOB, 'bob', 'Bob');
  await upsertContributor(CARA, 'cara', 'Cara');

  // --- Task lifecycle: draft → open, max 2 assignees ---
  const task = await createTask({ title: 'Write launch thread', description: 'A 5-tweet thread', reward: '50 USDC', maxAssignees: 2, createdBy: ADMIN });
  assert.equal(task.status, 'draft');
  assert.equal(task.max_assignees, 2);
  await assert.rejects(() => apply(task.id, ALICE, 'me!'), WorkflowError, 'cannot apply before open');
  assert.equal((await approveTask(task.id, ADMIN)).status, 'open');
  await assert.rejects(() => approveTask(task.id, ADMIN), WorkflowError, 'cannot re-approve a non-draft');

  // --- Applications ---
  const aliceApp = await apply(task.id, ALICE, 'Done 3 similar threads');
  const bobApp = await apply(task.id, BOB, 'Fast turnaround');
  const caraApp = await apply(task.id, CARA, 'Keen to learn');
  assert.equal((await listApplicantsAwaiting(task.id)).length, 3);
  await assert.rejects(() => apply(task.id, ALICE, 'again'), WorkflowError, 'no duplicate application');
  assert.equal((await getContributor(ALICE))!.applied_count, 1);

  // --- Withdraw + re-apply while slots are still open (row reused) ---
  await withdrawApplication(caraApp.id, CARA);
  assert.equal((await getApplication(caraApp.id))!.status, 'withdrawn');
  const caraReapply = await apply(task.id, CARA, 'Second try');
  assert.equal(caraReapply.id, caraApp.id, 're-apply reuses the same row');
  assert.equal(caraReapply.status, 'applied');

  // --- Assignment respects max_assignees (2 slots) ---
  await assignApplication(aliceApp.id, ADMIN);
  await assignApplication(bobApp.id, ADMIN);
  assert.equal(await countSlotsTaken(task.id), 2);
  await assert.rejects(() => assignApplication(caraApp.id, ADMIN), WorkflowError, 'slots full → cannot assign 3rd');
  await declineApplication(caraApp.id, ADMIN);
  assert.equal((await getApplication(caraApp.id))!.status, 'declined');
  assert.equal((await getApplication(aliceApp.id))!.status, 'assigned');
  assert.equal((await getContributor(ALICE))!.assigned_count, 1);

  // --- Applying to a fully-assigned task is blocked (spec: apply until slots filled) ---
  await assert.rejects(() => apply(task.id, CARA, 'again'), WorkflowError, 'no applications once all slots are filled');

  // --- Only the assignee submits; wrong user rejected ---
  await assert.rejects(() => submitWork(aliceApp.id, BOB, 'text', 'nope'), WorkflowError, 'not your application');

  // --- Alice: submit v1 → revise → submit v2 → approve ---
  const aliceV1 = await submitWork(aliceApp.id, ALICE, 'link', 'https://x.com/draft1');
  assert.equal(aliceV1.version, 1);
  await assert.rejects(() => submitWork(aliceApp.id, ALICE, 'text', 'again'), WorkflowError, 'cannot resubmit while pending review');
  await reviewSubmission(aliceV1.id, ADMIN, 'revise', 'Add the signup link');
  assert.equal((await latestSubmission(aliceApp.id))!.status, 'needs_revision');
  const aliceV2 = await submitWork(aliceApp.id, ALICE, 'link', 'https://x.com/draft2');
  assert.equal(aliceV2.version, 2);
  await reviewSubmission(aliceV2.id, ADMIN, 'approve', null);
  assert.equal((await latestSubmission(aliceApp.id))!.status, 'approved');
  assert.equal((await getContributor(ALICE))!.completed_count, 1);
  assert.equal((await listSubmissionVersions(aliceApp.id)).length, 2, 'both versions retained');

  // --- Approve is terminal for the assignment too: Assigned → Completed, atomically ---
  assert.equal((await getApplication(aliceApp.id))!.status, 'completed', 'approve moved the application to Completed');
  assert.equal((await getContributor(ALICE))!.assigned_count, 0, 'no longer in progress');
  assert.equal(await countSlotsTaken(task.id), 2, 'the completed slot stays consumed');
  await assert.rejects(() => withdrawApplication(aliceApp.id, ALICE), WorkflowError, 'completed → no withdraw');
  await assert.rejects(() => unassignApplication(aliceApp.id, ADMIN, 'reshuffle'), WorkflowError, 'completed → no unassign');
  await assert.rejects(() => submitWork(aliceApp.id, ALICE, 'text', 'more'), WorkflowError, 'completed → no resubmit');

  // --- Bob: submit → reject (terminal for the submission AND the assignment) ---
  const bobV1 = await submitWork(bobApp.id, BOB, 'text', 'my thread draft');
  await reviewSubmission(bobV1.id, ADMIN, 'reject', 'Off-brand');
  assert.equal((await getContributor(BOB))!.rejected_count, 1);
  assert.equal((await getContributor(BOB))!.assigned_count, 0, 'rejected work is no longer in progress');
  assert.equal((await latestSubmission(bobApp.id))!.reviewer_note, 'Off-brand', 'reviewer reason stored');
  assert.equal((await getApplication(bobApp.id))!.status, 'rejected', 'assignment closed atomically with the rejection');
  assert.equal(await countSlotsTaken(task.id), 1, 'bob’s slot is freed for someone else; alice’s stays consumed');
  await assert.rejects(() => apply(task.id, ALICE, 'encore'), WorkflowError, 'completed → no re-apply');
  await assert.rejects(() => submitWork(bobApp.id, BOB, 'text', 'try again'), WorkflowError, 'terminal — cannot resubmit');
  await assert.rejects(() => apply(task.id, BOB, 'round two'), WorkflowError, 'terminal — cannot re-apply to this task');
  await assert.rejects(() => assignApplication(bobApp.id, ADMIN), WorkflowError, 'terminal — cannot be re-assigned');

  // --- Announcement DMs are opt-in (default off), and the fan-out audience tracks it ---
  assert.equal((await getContributor(ALICE))!.announce_opt_in, 0, 'opt-in defaults to off');
  assert.equal((await listAnnounceRecipients()).length, 0, 'no one opted in by default');
  await setAnnounceOptIn(ALICE, true);
  assert.deepEqual((await listAnnounceRecipients()).map((c) => c.telegram_id), [ALICE], 'only opted-in contributors receive DMs');
  await setAnnounceOptIn(ALICE, false);
  assert.equal((await listAnnounceRecipients()).length, 0, 'opting back out removes them');

  // --- BIGINT: a realistic large Telegram id round-trips (would overflow 32-bit INT) ---
  const BIG = 6_000_000_000;
  await upsertContributor(BIG, 'big', 'Big Id');
  assert.equal((await getContributor(BIG))!.telegram_id, BIG, 'large Telegram id survives as BIGINT');

  // --- Concurrency: two managers assign to a 1-slot task at the same time ---
  // The FOR UPDATE row lock on the task admits exactly one — an oversell that
  // was impossible under synchronous better-sqlite3 (no yield point) and would
  // otherwise slip through READ COMMITTED once the DB layer became async.
  const GIO = 700;
  const HANA = 800;
  await upsertContributor(GIO, 'gio', 'Gio');
  await upsertContributor(HANA, 'hana', 'Hana');
  const raceTask = await createTask({ title: 'One slot only', description: 'x', maxAssignees: 1, createdBy: ADMIN });
  await approveTask(raceTask.id, ADMIN);
  const gioApp = await apply(raceTask.id, GIO, 'me');
  const hanaApp = await apply(raceTask.id, HANA, 'me too');
  const raceOutcomes = await Promise.allSettled([
    assignApplication(gioApp.id, ADMIN),
    assignApplication(hanaApp.id, ADMIN),
  ]);
  assert.equal(raceOutcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one concurrent assign won');
  assert.equal(raceOutcomes.filter((o) => o.status === 'rejected').length, 1, 'the other was rejected, not oversold');
  assert.equal(await countSlotsTaken(raceTask.id), 1, 'task not oversold past max_assignees=1');

  // --- Concurrency: two reviewers approve the SAME submission at once ---
  // The application-row lock admits one; the other re-reads the now-Approved
  // submission and is rejected — without it both would increment completed_count.
  const IVY = 900;
  await upsertContributor(IVY, 'ivy', 'Ivy');
  const revTask = await createTask({ title: 'Review race', description: 'x', createdBy: ADMIN });
  await approveTask(revTask.id, ADMIN);
  const ivyApp = await apply(revTask.id, IVY, 'pick me');
  await assignApplication(ivyApp.id, ADMIN);
  const ivySub = await submitWork(ivyApp.id, IVY, 'text', 'my work');
  const reviewOutcomes = await Promise.allSettled([
    reviewSubmission(ivySub.id, ADMIN, 'approve', null),
    reviewSubmission(ivySub.id, ADMIN, 'approve', null),
  ]);
  assert.equal(reviewOutcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one concurrent review won');
  assert.equal(reviewOutcomes.filter((o) => o.status === 'rejected').length, 1, 'the duplicate review was rejected');
  assert.equal((await getContributor(IVY))!.completed_count, 1, 'completed counted once, not twice');
  assert.equal((await listHistory(revTask.id)).filter((h) => h.action === 'completed').length, 1, 'one completion in history');

  // --- Concurrency: two admins approve the SAME draft at once ---
  // The task-row lock admits one; the other sees it already Open and is rejected —
  // without it both would duplicate 'approved' history and announce it publicly twice.
  const dblDraft = await createTask({ title: 'Approve race', description: 'x', createdBy: ADMIN });
  const approveOutcomes = await Promise.allSettled([
    approveTask(dblDraft.id, ADMIN),
    approveTask(dblDraft.id, ADMIN),
  ]);
  assert.equal(approveOutcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one concurrent approve won');
  assert.equal(approveOutcomes.filter((o) => o.status === 'rejected').length, 1, 'the duplicate approve was rejected');
  assert.equal((await getTask(dblDraft.id))!.status, 'open', 'draft opened exactly once');
  assert.equal((await listHistory(dblDraft.id)).filter((h) => h.action === 'approved').length, 1, 'one approval in history');

  // --- Concurrency: assign and decline race on the SAME application ---
  // The application-row lock admits one; the loser re-reads a status that is no
  // longer Applied and is rejected — without it the contributor could be DM'd
  // "assigned", end up Declined, and leak assigned_count (+1 forever).
  const JAY = 1000;
  await upsertContributor(JAY, 'jay', 'Jay');
  const adTask = await createTask({ title: 'Assign/decline race', description: 'x', createdBy: ADMIN });
  await approveTask(adTask.id, ADMIN);
  const jayApp = await apply(adTask.id, JAY, 'me');
  const adOutcomes = await Promise.allSettled([
    assignApplication(jayApp.id, ADMIN),
    declineApplication(jayApp.id, ADMIN),
  ]);
  assert.equal(adOutcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one concurrent decision won');
  const jayStatus = (await getApplication(jayApp.id))!.status;
  const jayAssigned = (await getContributor(JAY))!.assigned_count;
  assert.ok(
    (jayStatus === 'assigned' && jayAssigned === 1) || (jayStatus === 'declined' && jayAssigned === 0),
    `status and counter agree (status=${jayStatus}, assigned_count=${jayAssigned})`,
  );

  // --- Concurrency: submit and unassign race on the SAME application ---
  // Serialized by the same lock: either the submit lands first (the unassign is
  // then blocked by the pending review) or the unassign wins (the submit then
  // fails its Assigned check) — never an orphaned reviewable submission on an
  // application that has left Assigned.
  const KIM = 1100;
  await upsertContributor(KIM, 'kim', 'Kim');
  const usTask = await createTask({ title: 'Unassign/submit race', description: 'x', createdBy: ADMIN });
  await approveTask(usTask.id, ADMIN);
  const kimApp = await apply(usTask.id, KIM, 'me');
  await assignApplication(kimApp.id, ADMIN);
  const usOutcomes = await Promise.allSettled([
    submitWork(kimApp.id, KIM, 'text', 'work'),
    unassignApplication(kimApp.id, ADMIN, 'reshuffle'),
  ]);
  assert.equal(usOutcomes.filter((o) => o.status === 'fulfilled').length, 1, 'exactly one of submit/unassign won');
  const kimStatus = (await getApplication(kimApp.id))!.status;
  const kimLatest = await latestSubmission(kimApp.id);
  assert.ok(
    (kimStatus === 'assigned' && kimLatest?.status === 'submitted') ||
      (kimStatus === 'applied' && kimLatest === undefined),
    `no orphan (status=${kimStatus}, latest=${kimLatest?.status ?? 'none'})`,
  );

  // --- Concurrency: erasure races a counter-mutator on the same contributor ---
  // forget locks the contributor's application rows BEFORE the contributor row —
  // the same app→contributor order unassign uses (lock the app, then bump the
  // contributor counter). This asserts the invariant that holds on EVERY
  // interleaving: erasure completes, the contributor is gone, and the loser fails
  // cleanly (a WorkflowError once the row is gone). It also exercises the lock-order
  // path — a reversed order can surface as a raw 40P01 here on interleavings where
  // the cycle forms, though (single event loop) the two may also just serialize, so
  // this opportunistically catches that regression rather than guaranteeing it.
  const KAI = 1200;
  await upsertContributor(KAI, 'kai', 'Kai');
  const eraseTask = await createTask({ title: 'Erase race', description: 'x', createdBy: ADMIN });
  await approveTask(eraseTask.id, ADMIN);
  const kaiApp = await apply(eraseTask.id, KAI, 'in');
  await assignApplication(kaiApp.id, ADMIN);
  const eraseOutcomes = await Promise.allSettled([
    forgetContributor(KAI, ADMIN),
    unassignApplication(kaiApp.id, ADMIN, 'reshuffle'),
  ]);
  assert.equal(eraseOutcomes[0].status, 'fulfilled', 'erasure completed (no deadlock)');
  assert.equal(await getContributor(KAI), undefined, 'contributor erased regardless of interleaving');
  assert.ok(
    eraseOutcomes[1].status === 'fulfilled' ||
      (eraseOutcomes[1] as PromiseRejectedResult).reason instanceof WorkflowError,
    'the racing mutator settled cleanly — a WorkflowError, never a raw DB deadlock',
  );

  // --- Task close ---
  assert.equal((await closeTask(task.id, ADMIN)).status, 'closed');

  // --- History audit trail (task-level) ---
  const history = (await listHistory(task.id)).map((h) => h.action);
  assert.deepEqual(history, [
    'created', 'approved',
    'applied', 'applied', 'applied',
    'withdrawn', 'applied',
    'assigned', 'assigned', 'declined',
    'submitted', 'review_revise', 'submitted', 'review_approve', 'completed',
    'submitted', 'review_reject', 'rejected',
    'closed',
  ]);

  // --- Erasure: forget Cara ---
  await forgetContributor(CARA, ADMIN);
  assert.equal(await getContributor(CARA), undefined, 'contributor row deleted');
  assert.equal((await listApplicationsByContributor(CARA)).length, 0, 'applications deleted');
  assert.ok((await listHistory(task.id)).some((h) => h.action === 'contributor_forgotten'), 'erasure logged');
  assert.ok(
    (await listHistory(task.id)).every((h) => h.actor_id !== CARA && h.subject_id !== CARA),
    'no history entry still points at the erased contributor (actor or subject)',
  );

  // --- Erasure also scrubs task authorship (created_by is raw PII, no FK) ---
  const DREW = 400;
  await upsertContributor(DREW, 'drew', 'Drew');
  const drewTask = await createTask({ title: 'Drew’s task', description: 'x', createdBy: DREW });
  assert.equal((await getTask(drewTask.id))!.created_by, DREW);
  await forgetContributor(DREW, ADMIN);
  assert.equal((await getTask(drewTask.id))!.created_by, null, 'created_by nulled on erasure');

  // --- Erasure purges every notification addressed to OR about the contributor ---
  // Rendered text carries pitches/names and chat_id their Telegram id, so queued
  // rows must not deliver post-erasure and sent rows must not retain the content.
  await enqueue({ dedupKey: 'demo:erase-dm', chatId: String(BOB), subjectId: null, text: 'pending DM' });
  await enqueue({ dedupKey: 'demo:erase-sent', chatId: String(BOB), subjectId: null, text: 'delivered DM' });
  await markSent((await findByDedup('demo:erase-sent'))!.id);
  await enqueue({ dedupKey: 'demo:erase-card', chatId: String(ADMIN), subjectId: BOB, text: 'card quoting Bob’s pitch' });
  await enqueue({ dedupKey: 'demo:keep', chatId: String(ADMIN), subjectId: null, text: 'unrelated' });
  await forgetContributor(BOB, ADMIN);
  assert.equal(await findByDedup('demo:erase-dm'), undefined, 'queued DM purged');
  assert.equal(await findByDedup('demo:erase-sent'), undefined, 'already-sent DM row purged');
  assert.equal(await findByDedup('demo:erase-card'), undefined, 'admin card about them purged (subject_id)');
  assert.ok(await findByDedup('demo:keep'), 'unrelated notifications untouched');

  console.log('history:', history.join(' → '));
  console.log('alice:', await getContributor(ALICE));
  console.log('assignees on task:', (await listAssigned(task.id)).length);
  console.log('✅ CORE-MODEL DEMO PASSED — apply → assign → versioned submit → review, slots, erasure, queue.');
}

runScript(main);
