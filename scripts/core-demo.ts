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

const ADMIN = 1;
const ALICE = 100;
const BOB = 200;
const CARA = 300;

upsertContributor(ALICE, 'alice', 'Alice');
upsertContributor(BOB, 'bob', 'Bob');
upsertContributor(CARA, 'cara', 'Cara');

// --- Task lifecycle: draft → open, max 2 assignees ---
const task = createTask({ title: 'Write launch thread', description: 'A 5-tweet thread', reward: '50 USDC', maxAssignees: 2, createdBy: ADMIN });
assert.equal(task.status, 'draft');
assert.equal(task.max_assignees, 2);
assert.throws(() => apply(task.id, ALICE, 'me!'), WorkflowError, 'cannot apply before open');
assert.equal(approveTask(task.id, ADMIN).status, 'open');
assert.throws(() => approveTask(task.id, ADMIN), WorkflowError, 'cannot re-approve a non-draft');

// --- Applications ---
const aliceApp = apply(task.id, ALICE, 'Done 3 similar threads');
const bobApp = apply(task.id, BOB, 'Fast turnaround');
const caraApp = apply(task.id, CARA, 'Keen to learn');
assert.equal(listApplicantsAwaiting(task.id).length, 3);
assert.throws(() => apply(task.id, ALICE, 'again'), WorkflowError, 'no duplicate application');
assert.equal(getContributor(ALICE)!.applied_count, 1);

// --- Withdraw + re-apply while slots are still open (row reused) ---
withdrawApplication(caraApp.id, CARA);
assert.equal(getApplication(caraApp.id)!.status, 'withdrawn');
const caraReapply = apply(task.id, CARA, 'Second try');
assert.equal(caraReapply.id, caraApp.id, 're-apply reuses the same row');
assert.equal(caraReapply.status, 'applied');

// --- Assignment respects max_assignees (2 slots) ---
assignApplication(aliceApp.id, ADMIN);
assignApplication(bobApp.id, ADMIN);
assert.equal(countSlotsTaken(task.id), 2);
assert.throws(() => assignApplication(caraApp.id, ADMIN), WorkflowError, 'slots full → cannot assign 3rd');
declineApplication(caraApp.id, ADMIN);
assert.equal(getApplication(caraApp.id)!.status, 'declined');
assert.equal(getApplication(aliceApp.id)!.status, 'assigned');
assert.equal(getContributor(ALICE)!.assigned_count, 1);

// --- Applying to a fully-assigned task is blocked (spec: apply until slots filled) ---
assert.throws(() => apply(task.id, CARA, 'again'), WorkflowError, 'no applications once all slots are filled');

// --- Only the assignee submits; wrong user rejected ---
assert.throws(() => submitWork(aliceApp.id, BOB, 'text', 'nope'), WorkflowError, 'not your application');

// --- Alice: submit v1 → revise → submit v2 → approve ---
const aliceV1 = submitWork(aliceApp.id, ALICE, 'link', 'https://x.com/draft1');
assert.equal(aliceV1.version, 1);
assert.throws(() => submitWork(aliceApp.id, ALICE, 'text', 'again'), WorkflowError, 'cannot resubmit while pending review');
reviewSubmission(aliceV1.id, ADMIN, 'revise', 'Add the signup link');
assert.equal(latestSubmission(aliceApp.id)!.status, 'needs_revision');
const aliceV2 = submitWork(aliceApp.id, ALICE, 'link', 'https://x.com/draft2');
assert.equal(aliceV2.version, 2);
reviewSubmission(aliceV2.id, ADMIN, 'approve', null);
assert.equal(latestSubmission(aliceApp.id)!.status, 'approved');
assert.equal(getContributor(ALICE)!.completed_count, 1);
assert.equal(listSubmissionVersions(aliceApp.id).length, 2, 'both versions retained');

// --- Approve is terminal for the assignment too: Assigned → Completed, atomically ---
// Completed keeps its slot (no withdraw/unassign/re-apply/re-assign could free
// or refill it) but no longer counts as an assignment in progress.
assert.equal(getApplication(aliceApp.id)!.status, 'completed', 'approve moved the application to Completed');
assert.equal(getContributor(ALICE)!.assigned_count, 0, 'no longer in progress');
assert.equal(countSlotsTaken(task.id), 2, 'the completed slot stays consumed');
assert.throws(() => withdrawApplication(aliceApp.id, ALICE), WorkflowError, 'completed → no withdraw');
assert.throws(() => unassignApplication(aliceApp.id, ADMIN, 'reshuffle'), WorkflowError, 'completed → no unassign');
assert.throws(() => submitWork(aliceApp.id, ALICE, 'text', 'more'), WorkflowError, 'completed → no resubmit');

// --- Bob: submit → reject (terminal for the submission AND the assignment) ---
const bobV1 = submitWork(bobApp.id, BOB, 'text', 'my thread draft');
reviewSubmission(bobV1.id, ADMIN, 'reject', 'Off-brand');
assert.equal(getContributor(BOB)!.rejected_count, 1);
assert.equal(getContributor(BOB)!.assigned_count, 0, 'rejected work is no longer in progress');
assert.equal(latestSubmission(bobApp.id)!.reviewer_note, 'Off-brand', 'reviewer reason stored');
assert.equal(getApplication(bobApp.id)!.status, 'rejected', 'assignment closed atomically with the rejection');
assert.equal(countSlotsTaken(task.id), 1, 'bob’s slot is freed for someone else; alice’s stays consumed');
// A free slot exists now, so this exercises the Completed branch, not fullness.
assert.throws(() => apply(task.id, ALICE, 'encore'), WorkflowError, 'completed → no re-apply');
assert.throws(() => submitWork(bobApp.id, BOB, 'text', 'try again'), WorkflowError, 'terminal — cannot resubmit');
assert.throws(() => apply(task.id, BOB, 'round two'), WorkflowError, 'terminal — cannot re-apply to this task');
assert.throws(() => assignApplication(bobApp.id, ADMIN), WorkflowError, 'terminal — cannot be re-assigned');

// --- Announcement DMs are opt-in (default off), and the fan-out audience tracks it ---
assert.equal(getContributor(ALICE)!.announce_opt_in, 0, 'opt-in defaults to off');
assert.equal(listAnnounceRecipients().length, 0, 'no one opted in by default');
setAnnounceOptIn(ALICE, true);
assert.deepEqual(listAnnounceRecipients().map((c) => c.telegram_id), [ALICE], 'only opted-in contributors receive DMs');
setAnnounceOptIn(ALICE, false);
assert.equal(listAnnounceRecipients().length, 0, 'opting back out removes them');

// --- Task close ---
assert.equal(closeTask(task.id, ADMIN).status, 'closed');

// --- History audit trail (task-level) ---
const history = listHistory(task.id).map((h) => h.action);
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
forgetContributor(CARA, ADMIN);
assert.equal(getContributor(CARA), undefined, 'contributor row deleted');
assert.equal(listApplicationsByContributor(CARA).length, 0, 'applications deleted');
assert.ok(listHistory(task.id).some((h) => h.action === 'contributor_forgotten'), 'erasure logged');
assert.ok(
  listHistory(task.id).every((h) => h.actor_id !== CARA && h.subject_id !== CARA),
  'no history entry still points at the erased contributor (actor or subject)',
);

// --- Erasure also scrubs task authorship (created_by is raw PII, no FK) ---
const DREW = 400;
upsertContributor(DREW, 'drew', 'Drew');
const drewTask = createTask({ title: 'Drew’s task', description: 'x', createdBy: DREW });
assert.equal(getTask(drewTask.id)!.created_by, DREW);
forgetContributor(DREW, ADMIN);
assert.equal(getTask(drewTask.id)!.created_by, null, 'created_by nulled on erasure');

// --- Erasure purges every notification addressed to OR about the contributor ---
// Rendered text carries pitches/names and chat_id their Telegram id, so queued
// rows must not deliver post-erasure and sent rows must not retain the content.
enqueue({ dedupKey: 'demo:erase-dm', chatId: String(BOB), subjectId: null, text: 'pending DM' });
enqueue({ dedupKey: 'demo:erase-sent', chatId: String(BOB), subjectId: null, text: 'delivered DM' });
markSent(findByDedup('demo:erase-sent')!.id);
enqueue({ dedupKey: 'demo:erase-card', chatId: String(ADMIN), subjectId: BOB, text: 'card quoting Bob’s pitch' });
enqueue({ dedupKey: 'demo:keep', chatId: String(ADMIN), subjectId: null, text: 'unrelated' });
forgetContributor(BOB, ADMIN);
assert.equal(findByDedup('demo:erase-dm'), undefined, 'queued DM purged');
assert.equal(findByDedup('demo:erase-sent'), undefined, 'already-sent DM row purged');
assert.equal(findByDedup('demo:erase-card'), undefined, 'admin card about them purged (subject_id)');
assert.ok(findByDedup('demo:keep'), 'unrelated notifications untouched');

console.log('history:', history.join(' → '));
console.log('alice:', getContributor(ALICE));
console.log('assignees on task:', listAssigned(task.id).length);
console.log('✅ CORE-MODEL DEMO PASSED — apply → assign → versioned submit → review, slots, erasure, queue.');
