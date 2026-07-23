import { withTransaction, run } from './db.js';
import { config, isAdmin } from '../config.js';
import {
  TaskStatus,
  ApplicationStatus,
  SubmissionStatus,
  MAX_ASSIGNEES,
  isValidMaxAssignees,
} from './workflow.js';
import * as tasks from './models/task.js';
import * as applications from './models/application.js';
import * as submissions from './models/submission.js';
import * as contributors from './models/contributor.js';
import * as notifications from './models/notification.js';
import * as rooms from './models/room.js';
import * as signals from './models/signal.js';
import * as payouts from './models/payout.js';
import * as dao from '../near/dao.js';
import { accountExists, isValidAccountId } from '../near/account.js';
import { submitDaoProposal, outlayerConfigured } from '../near/outlayer.js';
import { addHistory, contributorDetail, eraseActor, deleteByTask as deleteHistoryByTask } from './models/history.js';
import type { Task, NewTaskInput } from './models/task.js';
import type { Application } from './models/application.js';
import type { Submission, SubmissionType } from './models/submission.js';

/** Thrown when an action violates a workflow rule. Message is safe to show a user. */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/**
 * User-facing text for an error: workflow messages verbatim, generic fallback
 * otherwise. Unexpected (non-workflow) errors are logged here, since catching
 * call sites hide them from the global bot.catch handler.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof WorkflowError) return err.message;
  console.error('[service] unexpected error:', err instanceof Error ? err.stack ?? err.message : err);
  return fallback;
}

/**
 * Authorization note: these mutators enforce *workflow* rules (valid state,
 * ownership) but trust the caller to have gated *role*. Admin-only entry points
 * in src/bot/ apply the admin check before calling; new call paths must too.
 */

/**
 * Fetch an application with its row locked for the rest of the transaction, or
 * throw. Every application mutator starts here (so all mutators are callable
 * only inside withTransaction): the lock serializes concurrent decisions on the
 * same application — assign vs decline, unassign vs submit, two reviews — which
 * under READ COMMITTED would otherwise all pass their status guards and
 * double-apply status writes and counter updates.
 */
async function requireApplication(applicationId: number): Promise<Application> {
  const app = await applications.getApplicationForUpdate(applicationId);
  if (!app) throw new WorkflowError(`Application #${applicationId} not found.`);
  return app;
}

/**
 * Fetch an application a contributor owns, row-locked like requireApplication,
 * or throw. Missing and not-owned raise the *same* message so a contributor
 * can't enumerate others' application ids by probing the id space (unlike
 * requireApplication, whose distinct "not found" is only exposed on
 * admin-gated paths).
 */
async function ownApplication(applicationId: number, contributorId: number): Promise<Application> {
  const app = await applications.getApplicationForUpdate(applicationId);
  if (!app || app.contributor_id !== contributorId) {
    throw new WorkflowError(`Application #${applicationId} not found (or not yours).`);
  }
  return app;
}

async function requireSubmission(submissionId: number): Promise<Submission> {
  const sub = await submissions.getSubmission(submissionId);
  if (!sub) throw new WorkflowError(`Submission #${submissionId} not found.`);
  return sub;
}

// ---- Tasks ----

export function createTask(input: NewTaskInput): Promise<Task> {
  const max = input.maxAssignees ?? 1;
  if (!isValidMaxAssignees(max)) {
    throw new WorkflowError(`Max assignees must be a whole number between 1 and ${MAX_ASSIGNEES}.`);
  }
  return withTransaction(async (): Promise<Task> => {
    const task = await tasks.createTask(input);
    await addHistory(task.id, 'created', input.createdBy);
    return task;
  });
}

/** Draft → Open (the "approve" step). */
export function approveTask(taskId: number, adminId: number): Promise<Task> {
  return withTransaction(async (): Promise<Task> => {
    // Lock the task row: two admins approving the same draft concurrently would
    // otherwise both pass the Draft guard (READ COMMITTED) and double-apply —
    // duplicate 'approved' history and a second public task announcement.
    const task = await tasks.getTaskForUpdate(taskId);
    if (!task) throw new WorkflowError(`Task #${taskId} not found.`);
    if (task.status !== TaskStatus.Draft) {
      throw new WorkflowError(`Task #${taskId} is "${task.status}" — only drafts can be approved.`);
    }
    const updated = await tasks.setStatus(task.id, TaskStatus.Open);
    await addHistory(task.id, 'approved', adminId);
    return updated;
  });
}

/**
 * Draft → gone: the reject path /approve pairs with approve. A draft may
 * distill private group chatter no human has released (see getPublicTask), so
 * declining to publish must neither force an approval — announcing exactly the
 * text being rejected — nor leave it parked in the queue forever. Draft-only:
 * every other status has public footprint (announcement, applications, money).
 * The row and its history are DELETED, not tombstoned (the same
 * erase-don't-suppress stance as /forget: an unreleased distillation shouldn't
 * outlive its rejection), and a drafting signal is closed out as 'discarded' so
 * the room tally reports the pipeline's net outcome. Locked like approveTask —
 * two admins deciding the same draft race on the same row.
 */
export function discardDraft(taskId: number, adminId: number): Promise<Task> {
  return withTransaction(async (): Promise<Task> => {
    const task = await tasks.getTaskForUpdate(taskId);
    if (!task) throw new WorkflowError(`Task #${taskId} not found.`);
    if (task.status !== TaskStatus.Draft) {
      throw new WorkflowError(`Task #${taskId} is "${task.status}" — only drafts can be discarded.`);
    }
    await signals.discardDrafted(task.id);
    await deleteHistoryByTask(task.id);
    await tasks.deleteTask(task.id);
    // The history died with the row — the ops log is the surviving audit trail.
    console.log(`[tasks] draft #${task.id} ("${task.title.slice(0, 40)}") discarded by ${adminId}`);
    return task;
  });
}

/**
 * Open → Closed. Stops NEW applications (apply and assign both require an Open
 * task); contributors already assigned can still submit and reviewers can still
 * finish existing work — closing never strands work in progress.
 */
export function closeTask(taskId: number, adminId: number): Promise<Task> {
  return transitionTask(taskId, TaskStatus.Open, TaskStatus.Closed, adminId, 'closed');
}

/** Closed → Open (admin reopens). A Draft is deliberately NOT reopenable: its
 *  one exit is approveTask, whose path carries the announcement fan-out —
 *  opening a draft here would publish it silently. */
export function reopenTask(taskId: number, adminId: number): Promise<Task> {
  return transitionTask(taskId, TaskStatus.Closed, TaskStatus.Open, adminId, 'reopened');
}

/** The close/reopen edge, guarded by its exact expected from-status (the same
 *  explicit style as approveTask — each edge names the one state it leaves). */
function transitionTask(taskId: number, from: TaskStatus, to: TaskStatus, adminId: number, action: string): Promise<Task> {
  return withTransaction(async (): Promise<Task> => {
    // Lock the task row (see approveTask): serializes concurrent close/reopen on
    // the same task so they can't both pass the transition guard and duplicate history.
    const task = await tasks.getTaskForUpdate(taskId);
    if (!task) throw new WorkflowError(`Task #${taskId} not found.`);
    if (task.status !== from) {
      throw new WorkflowError(`Task #${taskId} is "${task.status}" and cannot become "${to}".`);
    }
    const updated = await tasks.setStatus(task.id, to);
    await addHistory(task.id, action, adminId);
    return updated;
  });
}

// ---- Applications ----

/**
 * Why applying to `task` would be refused right now, or null when it would be
 * accepted — the single statement of the apply guard chain. apply() enforces it
 * under row locks; advisory surfaces (the agent's propose_apply) evaluate the
 * same chain with plain reads so they never offer an Apply card the mutator
 * would refuse. Messages are user-safe (WorkflowError-grade).
 *
 * `personal` marks a refusal whose wording encodes the CALLER's own state
 * (their existing application, their pending-count) — audience routing the
 * refusal producer declares, so a group surface knows to withhold it without
 * re-deriving which branch fired. Task-state refusals (not open, full) stay
 * group-speakable.
 */
export interface ApplyRefusal {
  message: string;
  personal: boolean;
}
export function applyRefusal(
  task: Task,
  slotsTaken: number,
  existing: Application | undefined,
  pendingApplications: number,
): ApplyRefusal | null {
  if (task.status !== TaskStatus.Open) {
    return { message: `Task #${task.id} is not open for applications.`, personal: false };
  }
  if (slotsTaken >= task.max_assignees) {
    return { message: `Task #${task.id} is fully assigned and not accepting applications right now.`, personal: false };
  }
  if (existing?.status === ApplicationStatus.Applied || existing?.status === ApplicationStatus.Assigned) {
    return { message: `You already have an application for task #${task.id}.`, personal: true };
  }
  if (existing?.status === ApplicationStatus.Completed) {
    return { message: `You already completed task #${task.id}. 🎉`, personal: true };
  }
  if (existing?.status === ApplicationStatus.Rejected) {
    // Terminal, unlike Declined — see the workflow.ts header.
    return { message: `Your work for task #${task.id} was rejected — you can't apply to it again.`, personal: true };
  }
  if (pendingApplications >= config.maxOpenApplications) {
    return {
      message: `You have ${pendingApplications} pending applications (max ${config.maxOpenApplications}). Wait for a decision first.`,
      personal: true,
    };
  }
  return null;
}

/** A contributor applies to an Open task with an optional pitch. */
export function apply(taskId: number, contributorId: number, pitch: string | null): Promise<Application> {
  return withTransaction(async (): Promise<Application> => {
    // Lock order — existing application → task → contributor — matches
    // assignApplication and forgetContributor, so these can never deadlock (the
    // reverse would). Lock the existing application row FIRST (if any): a re-apply
    // mutates it, so this serializes with concurrent admin decisions on it
    // (assign/decline) and, taken before the task lock, holds the ordering. Its
    // value is re-read below once the serializing locks are held. `locked`
    // remembers whether a row lock was actually taken here: the re-read below
    // must not acquire an application lock we DON'T already hold — by then we
    // hold the contributor lock, and a new application→? acquisition would
    // invert the order against a concurrent /forget (which holds the freshly
    // created row and wants the contributor) — a real deadlock cycle.
    const locked = await applications.getApplicationForUpdateBy(taskId, contributorId);
    // Lock the task row for the rest of the transaction (like assignApplication):
    // the slot check and the create below must not straddle a concurrent final-slot
    // assignment, or both pass their slot guards under READ COMMITTED and oversell
    // the task — leaving an Applied application on a full task that can only ever
    // error on Assign and needlessly consumes one of the contributor's open slots.
    const task = await tasks.getTaskForUpdate(taskId);
    if (!task) throw new WorkflowError(`Task #${taskId} not found.`);
    // Lock the contributor row BEFORE counting their pending applications, so the
    // MAX_OPEN_APPLICATIONS decision is atomic: a concurrent apply() by the same
    // contributor (even to a different task) blocks here and re-counts after we
    // commit, instead of both reading a stale count and overshooting the cap. The
    // bot upserts the contributor before apply, so a missing row means a concurrent
    // /forget just erased them — surface it as a clean error, not the raw FK
    // violation the INSERT below would otherwise throw against forget's delete.
    if (!(await contributors.getContributorForUpdate(contributorId))) {
      throw new WorkflowError(`Your account was just erased. Send /start to register again before applying.`);
    }
    // Re-read the application now that the task + contributor rows are locked. A
    // concurrent FIRST-TIME apply to this same task has committed by this point if
    // it happened (the task lock serialized us behind it), so this snapshot is
    // authoritative — turning a double-tap into the clean "you already have an
    // application" refusal instead of a raw UNIQUE(task_id, contributor_id) error.
    // Locked re-read only when we already hold the row's lock (re-acquiring a
    // held lock can't deadlock); a row that APPEARED since is read plain — it's
    // refused below, never mutated, so no late lock is needed (see `locked`).
    const existing = locked
      ? await applications.getApplicationForUpdateBy(taskId, contributorId)
      : await applications.getApplicationFor(taskId, contributorId);
    const refusal = applyRefusal(
      task,
      await countSlotsTaken(taskId),
      existing,
      await countPendingApplications(contributorId),
    );
    if (refusal) throw new WorkflowError(refusal.message);
    // The concurrent-creation corner left one path where `existing` is unlocked:
    // the row appeared after our first read AND an admin already decided it
    // (declined/withdrawn ⇒ no refusal above). Reusing it here would UPDATE a row
    // we never locked — the same late acquisition the plain re-read avoids. It
    // took two interleaved writers inside this transaction's lifetime to get
    // here; a retry sees a settled row and proceeds normally.
    if (existing && !locked) {
      throw new WorkflowError('Your application for this task just changed — try again.');
    }

    let app: Application;
    if (existing) {
      // Re-apply after a previous decline/withdrawal reuses the row, with the new
      // pitch — and without re-counting: applied_count tracks distinct applications.
      app = await applications.reapply(existing.id, pitch);
    } else {
      app = await applications.createApplication(taskId, contributorId, pitch);
      await contributors.incrementApplied(contributorId);
    }
    await addHistory(taskId, 'applied', contributorId, pitch, contributorId);
    return app;
  });
}

/**
 * An application decision plus the task it belongs to. The mutator resolves the
 * task inside its transaction and hands it back so the caller can notify without
 * a post-commit re-read — one that could race a concurrent /forget deleting the
 * row (returning undefined and throwing on the deref).
 */
export interface ApplicationResult {
  application: Application;
  task: Task | undefined;
  /** Set by assignApplication: this assignment consumed the task's LAST open
   *  slot (computed under the task lock, so it's authoritative). The caller
   *  notifies the remaining applicants their wait just changed shape — without
   *  it they'd sit on a full task with no signal. */
  filled?: boolean;
}

/** Applied → Assigned (admin), if the task still has an open slot. */
export function assignApplication(applicationId: number, adminId: number): Promise<ApplicationResult> {
  return withTransaction(async (): Promise<ApplicationResult> => {
    const app = await requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Applied) {
      throw new WorkflowError(`Application #${applicationId} is "${app.status}" and cannot be assigned.`);
    }
    // Lock the task row for the rest of the transaction: two managers assigning
    // to the same task concurrently would otherwise both read an open slot
    // (READ COMMITTED hides each other's uncommitted assignment) and oversell it.
    // The FOR UPDATE serializes them — the second waits, then sees the taken slot.
    const task = await tasks.getTaskForUpdate(app.task_id);
    if (!task) throw new WorkflowError(`Task #${app.task_id} not found.`);
    if (task.status !== TaskStatus.Open) {
      throw new WorkflowError(`Task #${task.id} is not open.`);
    }
    const taken = await countSlotsTaken(task.id);
    if (taken >= task.max_assignees) {
      throw new WorkflowError(`Task #${task.id} already has ${taken}/${task.max_assignees} assignees.`);
    }
    const updated = await applications.setStatus(app.id, ApplicationStatus.Assigned);
    await contributors.incrementAssigned(app.contributor_id);
    await addHistory(task.id, 'assigned', adminId, contributorDetail(app.contributor_id), app.contributor_id);
    return { application: updated, task, filled: taken + 1 >= task.max_assignees };
  });
}

/** Applied → Declined (admin passes on an applicant). */
export function declineApplication(applicationId: number, adminId: number): Promise<ApplicationResult> {
  return withTransaction(async (): Promise<ApplicationResult> => {
    const app = await requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Applied) {
      throw new WorkflowError(`Application #${applicationId} is "${app.status}" and cannot be declined.`);
    }
    const updated = await applications.setStatus(app.id, ApplicationStatus.Declined);
    await addHistory(app.task_id, 'declined', adminId, contributorDetail(app.contributor_id), app.contributor_id);
    return { application: updated, task: await tasks.getTask(app.task_id) };
  });
}

/**
 * Assigned → Applied (admin frees the slot; the contributor stays an applicant).
 * The reason is required and preserved in the task history.
 */
export function unassignApplication(applicationId: number, adminId: number, reason: string): Promise<ApplicationResult> {
  return withTransaction(async (): Promise<ApplicationResult> => {
    const app = await requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Assigned) {
      throw new WorkflowError(`Application #${applicationId} is not assigned.`);
    }
    await assertNoPendingReview(app);
    const updated = await applications.setStatus(app.id, ApplicationStatus.Applied);
    await contributors.decrementAssigned(app.contributor_id);
    await addHistory(app.task_id, 'unassigned', adminId, contributorDetail(app.contributor_id, reason), app.contributor_id);
    return { application: updated, task: await tasks.getTask(app.task_id) };
  });
}

/**
 * An application with work awaiting review may not leave Assigned (withdraw or
 * unassign) — otherwise the submission would stay reviewable while orphaned,
 * and a decision would credit/debit someone no longer assigned. The reviewer
 * resolves the pending version first; then the exit is legal. (Approved work
 * needs no guard here: approval moves the application to Completed in the same
 * transaction, so an Assigned application never carries an approved latest.)
 */
async function assertNoPendingReview(app: Application): Promise<void> {
  const latest = await submissions.latestForApplication(app.id);
  if (latest && latest.status === SubmissionStatus.Submitted) {
    throw new WorkflowError(
      `Submission v${latest.version} for task #${app.task_id} is awaiting review — it must be reviewed first.`,
    );
  }
}

/** Applied | Assigned → Withdrawn (contributor pulls out of their own application). */
export function withdrawApplication(applicationId: number, contributorId: number): Promise<Application> {
  return withTransaction(async (): Promise<Application> => {
    const app = await ownApplication(applicationId, contributorId);
    if (app.status !== ApplicationStatus.Applied && app.status !== ApplicationStatus.Assigned) {
      throw new WorkflowError(`Application #${applicationId} is "${app.status}" and cannot be withdrawn.`);
    }
    if (app.status === ApplicationStatus.Assigned) {
      await assertNoPendingReview(app);
      await contributors.decrementAssigned(app.contributor_id);
    }
    const updated = await applications.setStatus(app.id, ApplicationStatus.Withdrawn);
    await addHistory(app.task_id, 'withdrawn', contributorId, null, contributorId);
    return updated;
  });
}

// ---- Submissions ----

/**
 * A submission mutation plus its application and task — the context a caller
 * needs to notify reviewers or the contributor. Resolved inside the transaction
 * so the caller never re-reads the application afterward: a post-commit read
 * could race a concurrent /forget deleting the row and throw on the deref.
 */
export interface SubmissionResult {
  submission: Submission;
  application: Application;
  task: Task | undefined;
}

/**
 * Why submitting on `app` would be refused right now, or null when a new version
 * would be accepted — the single statement of the submit guard (applyRefusal's
 * twin). submitWork enforces it inside its transaction; button surfaces (/myapps,
 * /submit) evaluate the same chain so a Submit tap can never be a guaranteed
 * bounce. No Approved or Rejected guard is needed: a review decision moves the
 * application to Completed / Rejected in the same transaction (reviewSubmission),
 * and both are terminal — so an Assigned application can never carry an approved
 * or rejected latest version.
 */
export function submitRefusal(app: Application, latest: Submission | undefined): string | null {
  if (app.status !== ApplicationStatus.Assigned) return `You are not assigned to this task.`;
  if (latest?.status === SubmissionStatus.Submitted) {
    return `Your submission is awaiting review — nothing to resubmit yet.`;
  }
  return null;
}

/**
 * An assigned contributor submits work (a new version). Allowed when there is no
 * prior version, or the latest was sent back for revision.
 */
export function submitWork(
  applicationId: number,
  contributorId: number,
  type: SubmissionType,
  content: string,
  caption: string | null = null,
): Promise<SubmissionResult> {
  return withTransaction(async (): Promise<SubmissionResult> => {
    const app = await ownApplication(applicationId, contributorId);
    const latest = await submissions.latestForApplication(app.id);
    const refusal = submitRefusal(app, latest);
    if (refusal) throw new WorkflowError(refusal);
    const sub = await submissions.createSubmission(app.id, type, content, caption);
    await addHistory(app.task_id, 'submitted', contributorId, `v${sub.version} ${type}`, contributorId);
    return { submission: sub, application: app, task: await tasks.getTask(app.task_id) };
  });
}

export type ReviewDecision = 'approve' | 'reject' | 'revise';

const DECISION_STATUS: Record<ReviewDecision, SubmissionStatus> = {
  approve: SubmissionStatus.Approved,
  reject: SubmissionStatus.Rejected,
  revise: SubmissionStatus.NeedsRevision,
};

/**
 * Review the latest submitted work: approve / reject / request revision.
 * Revise is the recoverable outcome (the application stays Assigned and a new
 * version is expected). Approve and reject are terminal for the submission AND
 * the assignment, atomically: approve moves the application Assigned →
 * Completed (the slot stays consumed — completed work legitimately keeps it);
 * reject moves it Assigned → Rejected and frees the slot. Both transitions
 * land in history alongside the review decision.
 */
export function reviewSubmission(
  submissionId: number,
  reviewerId: number,
  decision: ReviewDecision,
  note: string | null,
): Promise<SubmissionResult> {
  return withTransaction(async (): Promise<SubmissionResult> => {
    // Resolve the application id first (probe read — application_id is
    // immutable), then take the application row lock, then RE-read the
    // submission under it. Every submission writer (submitWork, this function)
    // holds the same lock, so the re-read status is stable for the rest of the
    // transaction — two concurrent reviews serialize instead of both passing
    // the Submitted check and double-applying counters.
    const probe = await requireSubmission(submissionId);
    const app = await requireApplication(probe.application_id);
    const sub = await requireSubmission(submissionId);
    if (sub.status !== SubmissionStatus.Submitted) {
      throw new WorkflowError(`Submission #${submissionId} is "${sub.status}" and cannot be reviewed.`);
    }
    const reviewed = await submissions.setReview(sub.id, DECISION_STATUS[decision], note);
    await addHistory(app.task_id, `review_${decision}`, reviewerId, note, app.contributor_id);
    // Loaded once here for both the payout check below and the returned result.
    const task = await tasks.getTask(app.task_id);
    if (decision === 'approve') {
      await contributors.incrementCompleted(app.contributor_id);
      await contributors.decrementAssigned(app.contributor_id); // no longer in progress
      await applications.setStatus(app.id, ApplicationStatus.Completed);
      await addHistory(app.task_id, 'completed', reviewerId, contributorDetail(app.contributor_id), app.contributor_id);
      // Approved work on a rewarded task is owed a payout — recorded in the SAME
      // transaction as the approval, so the ledger can't diverge from the decision.
      // The free-text reward is snapshotted; its on-chain amount is set when an
      // admin proposes the DAO Transfer (/pay). Rewardless tasks record none.
      if (task?.reward) {
        await payouts.createPayout(app.task_id, app.contributor_id, sub.id, task.reward);
      }
    }
    if (decision === 'reject') {
      await contributors.incrementRejected(app.contributor_id);
      await contributors.decrementAssigned(app.contributor_id); // no longer in progress
      await applications.setStatus(app.id, ApplicationStatus.Rejected);
      await addHistory(
        app.task_id,
        'rejected',
        reviewerId,
        contributorDetail(app.contributor_id, note ?? 'submission rejected'),
        app.contributor_id,
      );
    }
    return { submission: reviewed, application: app, task };
  });
}

// ---- Rooms & room admins ----

/**
 * Bot-added-to-group bootstrap: create (or retitle) the room and make the
 * inviter its first admin, in one transaction. `inviterId` is null when a bot
 * or anonymous admin did the adding — the room then starts with no admins and
 * a global admin bootstraps it via /addroomadmin.
 */
export function registerRoom(
  chatId: number,
  title: string | null,
  inviterId: number | null,
): Promise<{ room: rooms.Room; inviterBecameAdmin: boolean }> {
  return withTransaction(async () => {
    const room = await rooms.upsertRoom(chatId, title);
    const inviterBecameAdmin = inviterId !== null && (await rooms.addAdmin(chatId, inviterId));
    return { room, inviterBecameAdmin };
  });
}

/**
 * A group upgraded to a supergroup: Telegram retires the old chat id and issues
 * a new one, announced by a service message (no my_chat_member fires). Move
 * everything keyed by the old id in one transaction — the room row, its admins,
 * signal history, task provenance, and queued notifications — or the room goes
 * silently dark and its admins lose access (registerRoom sits behind the manager
 * gate, so they could not re-bootstrap). FK order: rooms.chat_id is referenced
 * by room_admins/signals/tasks with no cascade, so copy the parent first, move
 * the children, then drop the retired row. Idempotent: both sides of the rename
 * announce it, and whichever handler runs second finds nothing left to move.
 */
export function migrateRoomChat(oldChatId: number, newChatId: number): Promise<void> {
  if (oldChatId === newChatId) return Promise.resolve();
  return withTransaction(async () => {
    // Lock the old room row first (the same lock every room mutator takes): a
    // concurrent claimSignalSlot/addRoomAdmin holding it could otherwise commit
    // a child row between our child moves and dropRoom — an FK abort that rolls
    // the whole migration back with no retry (the service message is consumed).
    // Under the lock they either committed before us (their row gets moved) or
    // re-read after us and find the room gone.
    await rooms.getRoomForUpdate(oldChatId);
    await rooms.copyRoomTo(oldChatId, newChatId);
    await rooms.moveAdmins(oldChatId, newChatId);
    await signals.moveRoom(oldChatId, newChatId);
    await tasks.moveRoom(oldChatId, newChatId);
    await rooms.dropRoom(oldChatId);
    await notifications.redirectQueuedChat(String(oldChatId), String(newChatId));
  });
}

/**
 * Fetch a room with its row locked for the rest of the transaction, or throw.
 * The row-lock-first read every room mutator starts with (the room equivalent of
 * requireApplication): serializes concurrent writes to the same room — a signal
 * toggle vs a budget claim, two admin changes — that READ COMMITTED would
 * otherwise let interleave. `claimSignalSlot` takes the same lock, so a
 * `/disablesignals` and an in-flight slot claim can't straddle each other.
 */
async function requireRoomForUpdate(chatId: number): Promise<rooms.Room> {
  const room = await rooms.getRoomForUpdate(chatId);
  if (!room) throw new WorkflowError('This group is not registered as a room yet.');
  return room;
}

export function setRoomSignals(chatId: number, enabled: boolean): Promise<rooms.Room> {
  return withTransaction(async () => {
    await requireRoomForUpdate(chatId);
    return rooms.setSignalsEnabled(chatId, enabled);
  });
}

export function setRoomAi(chatId: number, enabled: boolean): Promise<rooms.Room> {
  return withTransaction(async () => {
    await requireRoomForUpdate(chatId);
    return rooms.setAiEnabled(chatId, enabled);
  });
}

export function addRoomAdmin(chatId: number, telegramId: number): Promise<boolean> {
  return withTransaction(async () => {
    await requireRoomForUpdate(chatId);
    return rooms.addAdmin(chatId, telegramId);
  });
}

export function removeRoomAdmin(chatId: number, telegramId: number): Promise<boolean> {
  return rooms.removeAdmin(chatId, telegramId);
}

/**
 * Everyone allowed to act on this task — global admins plus, for a room task,
 * that room's admins (deduped). The task-event notification audience: a room
 * admin who can approve or review a task must also hear about it.
 */
export async function taskManagerIds(task: Pick<Task, 'room_chat_id'> | undefined): Promise<number[]> {
  const ids = new Set<number>(config.adminIds);
  if (task?.room_chat_id != null) {
    for (const id of await rooms.listAdmins(task.room_chat_id)) ids.add(id);
  }
  return [...ids];
}

/**
 * Room-aware role check — the single-user predicate twin of taskManagerIds:
 * global admins manage every task; room admins manage the tasks of a room they
 * administer; a task with no room (created via DM) is global-admin-only. The
 * ONE encoding of the manage rule, shared by the bot's command/callback gates
 * and the scenes' commit-time re-checks — a change to the rule (e.g. creator
 * rights) lands here once instead of drifting across re-derivations.
 */
export async function canManageTask(
  userId: number | undefined,
  task: Pick<Task, 'room_chat_id'> | undefined,
): Promise<boolean> {
  if (userId === undefined) return false;
  if (isAdmin(userId)) return true;
  return task?.room_chat_id != null && rooms.isAdmin(task.room_chat_id, userId);
}

// ---- Signals (AI-drafted tasks from opted-in group chats) ----

/**
 * Claim one unit of a room's hourly AI budget, or return null when the budget
 * is spent. The row is created BEFORE the model runs (status 'evaluating') and
 * inside a transaction, so concurrent messages can never overdraw the budget —
 * an evaluation that dies mid-flight still consumed its claim for that hour.
 */
export function claimSignalSlot(roomChatId: number, maxPerHour: number): Promise<number | null> {
  return withTransaction(async (): Promise<number | null> => {
    // Lock the room row so concurrent group messages can't both pass the hourly
    // check and overdraw the AI budget (the same TOCTOU the count-then-insert
    // would otherwise allow under READ COMMITTED).
    const room = await requireRoomForUpdate(roomChatId);
    // Re-read signals_enabled UNDER the lock: handleGroupMessage's opt-in check
    // was an unlocked read, so a /disablesignals may have committed since (it
    // locks the same row). Bail rather than ship a now-opted-out room's text to
    // the model — the /privacy "group chatter is never recorded" promise.
    if (!room.signals_enabled) return null;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if ((await signals.countSince(roomChatId, oneHourAgo)) >= maxPerHour) return null;
    // Global cap on top of the per-room one: rooms are free to create (any group
    // join registers one), so per-room × unlimited rooms is otherwise unbounded
    // model spend. The room lock doesn't serialize ACROSS rooms, so concurrent
    // claims can overshoot this by the concurrency width — fine for a spend
    // ceiling; the per-room budget stays exact.
    if ((await signals.countAllSince(oneHourAgo)) >= config.signalGlobalMaxPerHour) return null;
    return signals.createEvaluating(roomChatId);
  });
}

/** The evaluation produced no task (low score, AI unavailable, or bad output). */
export function discardSignal(signalId: number, score: number | null): Promise<void> {
  return signals.finish(signalId, score, 'discarded', null);
}

/**
 * Reclaim signal slots left 'evaluating' by a process that died mid-evaluation
 * (an unclean SIGKILL/crash — a graceful shutdown aborts and discards inline).
 * Run once at boot as the single writer; see signals.reclaimEvaluating. Returns
 * the number of orphaned rows cleared.
 */
export function reclaimStaleSignals(): Promise<number> {
  return signals.reclaimEvaluating();
}

export interface SignalDraft {
  title: string;
  description: string;
  requiredOutput: string | null;
  deadline: string | null;
  /** Already clamped to 1–20 by the AI layer; null → createTask's default of 1. */
  maxAssignees: number | null;
}

export interface DraftedSignal {
  task: Task;
  /**
   * The room's title as of the draft, read inside the same transaction — so the
   * manager alert names the CURRENT group name even if it was retitled during the
   * (up to 30s) AI evaluation, rather than the stale title read before it started.
   */
  roomTitle: string | null;
}

/**
 * A signal cleared the bar: create a Draft task belonging to the room and close
 * the signal, atomically. The task is a DRAFT — a human still approves it — and
 * carries no author: the message writer never opted into the bot, so recording
 * them would break the /privacy promise (created_by stays null; the history
 * detail names only the score).
 */
export function draftTaskFromSignal(signalId: number, roomChatId: number, draft: SignalDraft, score: number): Promise<DraftedSignal> {
  const attempt = (): Promise<DraftedSignal> => withTransaction(async (): Promise<DraftedSignal> => {
    // The room id travels with the SIGNAL row, not the caller: the AI evaluation
    // takes seconds, and a group→supergroup migration in that window moves the
    // room (and this signal row) to a new chat id — the captured id would then
    // FK-fail the insert and lose the draft. The row's current room_chat_id is
    // the post-migration truth; the caller's id is only the fallback.
    const currentRoomId = (await signals.roomOf(signalId)) ?? roomChatId;
    const task = await tasks.createTask({
      title: draft.title,
      description: draft.description,
      requiredOutput: draft.requiredOutput,
      deadline: draft.deadline,
      maxAssignees: draft.maxAssignees ?? undefined,
      createdBy: null,
      roomChatId: currentRoomId,
    });
    await addHistory(task.id, 'created', null, `auto-drafted from a group signal (score ${score})`);
    await signals.finish(signalId, score, 'drafted', task.id);
    const room = await rooms.getRoom(currentRoomId);
    return { task, roomTitle: room?.title ?? null };
  });
  // The roomOf read above only sees a COMMITTED migration. One that commits
  // between that read and the insert's FK check still aborts the transaction
  // (the old room row is gone by the time our blocked FK check runs) — a
  // sub-second window, but it loses the draft and strands the signal
  // 'evaluating' until the next boot's reclaim. One retry re-reads roomOf,
  // which now returns the successor chat id; a room genuinely DELETED (not
  // migrated) fails the retry too and surfaces normally.
  return attempt().catch((err) =>
    (err as { code?: string }).code === '23503' ? attempt() : Promise.reject(err),
  );
}

// ---- Erasure (right-to-be-forgotten) ----

/** Delete a contributor's PII: their profile, applications, and submissions; anonymize history. */
export async function forgetContributor(telegramId: number, adminId: number): Promise<void> {
  // A 'proposed' row blocks erasure two ways: a live proposal the council can
  // still approve, or an approved-but-FAILED transfer (attention) that needs a
  // re-finalize — never a vote. The instruction must match which one, or an
  // admin waits on a council action that can't happen.
  const openProposalError = (payoutId: number, attention: boolean): WorkflowError =>
    new WorkflowError(
      attention
        ? `Contributor ${telegramId}'s DAO payout (payout #${payoutId}) was approved but the transfer failed — ` +
          `re-finalize it (see /payouts), then /forget.`
        : `Contributor ${telegramId} has an open DAO payout proposal (payout #${payoutId}) — ` +
          `let the council approve or reject it, then /forget.`,
    );
  const tryAgainError = (payoutId: number): WorkflowError =>
    new WorkflowError(
      `Couldn't confirm the DAO proposal state for contributor ${telegramId}'s payout #${payoutId}. ` +
        `Money-before-erasure means /forget waits until the check succeeds — try again shortly.`,
    );
  const duplicateHazardError = (payoutId: number): WorkflowError =>
    new WorkflowError(
      `Contributor ${telegramId}'s payout #${payoutId} has a live DUPLICATE proposal for the same ` +
        `transfer (one proposed out-of-band) — have the council reject the extra one, then /forget.`,
    );
  // Money before erasure: a 'proposed' payout is an OPEN Transfer proposal the
  // council can approve at any time — cascade the ledger row away and a later
  // approval still pays out, to an account whose owner we just erased, with no
  // row recording who or why. Reconcile each in-flight row first
  // (reconcilePayout — the shared settlement rule; it also adopts a lost
  // proposal_id by description and settles paid/re-queued rows so they stop
  // blocking), then refuse while any is still open, failing CLOSED on an
  // unreadable proposal. Runs BEFORE the transaction (network reads).
  if (config.daoContractId) {
    // Reconcile EVERY row and let the one dispatcher decide what needs the
    // chain: reconcilePayout is free where nothing can be in flight (paid rows
    // and never-claimed pending rows return without a read) and chain-checks
    // exactly the rest — 'proposed' rows, and healed claims still carrying
    // claim memory (see payouts.resetToPending) whose unaccounted-for proposal
    // (a gateway-reported-failed submit) can land within the tx-validity bound. Re-encoding that predicate here would be a
    // drift seam on the exact double-pay/erasure class this guard closes.
    // Residual: a stale command run AFTER erasure lands a proposal with no
    // ledger row behind it — the council's verify-before-voting rule
    // (docs/outlayer-setup.md) is the backstop there.
    // The reconciles are independent chain reads — run them concurrently over
    // one shared window snapshot (a degraded RPC then costs ~one 15s timeout,
    // not N of them serialized), and apply the checks in row order below.
    const rows = await payouts.listByContributor(telegramId);
    const window = proposalWindow();
    // auditPaid: erasure is the one caller that must also chain-check PAID rows
    // for a live duplicate of the executed transfer (see reconcilePayout).
    const recs = await Promise.all(rows.map((row) => reconcilePayout(row, window, { auditPaid: true })));
    for (const [i, rec] of recs.entries()) {
      const p = rows[i];
      // A proposal confirmed still open is real money the council can send — block.
      // (A live duplicate alongside it still can't escape: resolving the open
      // proposal either pays it — and the paid-row audit below then blocks on
      // the twin — or resets the row, and the twin gets adopted as the new open
      // proposal. /payouts names the duplicate on the row either way.)
      if (rec.ok && rec.status === 'proposed') throw openProposalError(p.id, rec.attention);
      // A live twin of this payout's own (usually already-executed) transfer —
      // one council vote from an unrecorded second payment; kill it first.
      if (rec.duplicateProposals) throw duplicateHazardError(p.id);
      // Reconcile advanced/re-queued it (paid, or back to pending) — nothing in flight.
      if (rec.ok) continue;
      // Couldn't confirm — erasure WAITS, whatever the cause. That includes a
      // young 'proposed'+null claim (rec.held): a scan seeing nothing on-chain
      // does NOT prove the admin's add_proposal isn't mid-flight, so resetting it
      // here would let erasure race real money. Reconcile auto-heals a genuinely
      // abandoned claim to 'pending' once ABANDONED_CLAIM_GRACE_MS lapses, and
      // /forget then proceeds — erasure is delayed by at most the grace, never lost.
      throw tryAgainError(p.id);
    }
  }
  return withTransaction(async (): Promise<void> => {
    // Lock this contributor's application rows BEFORE the contributor row — the
    // same app→contributor order every counter-bumping mutator uses (they lock the
    // application via requireApplication, then UPDATE the contributor counters).
    // Taking the contributor lock first here (then locking applications implicitly
    // via deleteByContributor) reverses that order and deadlocks a concurrent
    // assign/review/unassign/withdraw on one of these applications (Postgres 40P01).
    await applications.lockByContributor(telegramId);
    // Then lock this contributor's payout rows, so the 'proposed' backstop below
    // runs against a state a concurrent /pay can't change under us: /pay's claim
    // (getByIdForUpdate → pending→proposed) either committed BEFORE this lock (the
    // count sees 'proposed' and blocks) or waits BEHIND it (and, once we cascade
    // the row away, /pay's getByIdForUpdate finds it gone and can't propose for an
    // erased contributor). Without this lock the claim could commit between the
    // count and the cascade DELETE — money in flight, ledger + PII erased.
    await payouts.lockByContributor(telegramId);
    // In-transaction backstop for the DAO path — also catches a 'proposed' row
    // when DAO_CONTRACT_ID went missing from the env (the preflight above is gated
    // on it; money in flight must fail closed, not slip through a config gap).
    if ((await payouts.countByContributorStatus(telegramId, 'proposed')) > 0) {
      throw new WorkflowError(
        `Contributor ${telegramId} has an open DAO payout proposal — ` +
          `let the council approve or reject it, then /forget.`,
      );
    }
    // Claim-memory backstop, UNCONDITIONAL: a healed claim (a 'pending' row
    // keeping its pinned receiver+amount inside the CLAIM_MEMORY_TTL watch
    // window) means a proposal could STILL land on-chain — the same bounded
    // possibility /pay refuses to cross (assertNoConflictingClaim). Erasing
    // past it would cascade the ledger row away and let a late-landing,
    // approvable Transfer pay an erased person with no record. The preflight
    // above already settled or expired what the chain could prove (an expired
    // memory was cleared there and passes this count); anything remaining is
    // inside its ≤48h window — erasure waits it out: delayed at most the TTL,
    // never lost, and consistent with /pay. Without DAO_CONTRACT_ID nothing
    // could even be checked — same refusal, different instruction.
    if ((await payouts.countPendingClaimMemory(telegramId)) > 0) {
      throw new WorkflowError(
        config.daoContractId
          ? `Contributor ${telegramId} has a recent payout claim whose proposal could still land ` +
            `on-chain (watched ~48h) — /forget after it settles or the watch window ends.`
          : `Contributor ${telegramId} has a payout claim whose on-chain state can't be verified ` +
            `(DAO not configured) — restore DAO_CONTRACT_ID, then /forget.`,
      );
    }
    // Row-locked: detached producers that guard on the contributor's existence
    // (notifyReviewerNote) take the same lock first, so nothing can pass its
    // existence check and then insert AFTER this purge ran — the lock is held
    // through the notification + contributor deletes below.
    const profile = await contributors.getContributorForUpdate(telegramId);
    // Room-admin rows are PII that exists WITHOUT a contributor profile:
    // promotion happens in a group, and profiles are only created in private
    // chats — a promotee who never DM'd the bot has room_admins rows and
    // possibly queued notifications (the promotion DM) as their entire
    // footprint. Erase those unconditionally so that identity class has an
    // erasure path at all.
    const roomAdminRows = await rooms.deleteAdminEverywhere(telegramId);
    if (!profile) {
      // No profile ⇒ no applications/submissions/history (all keyed off it) —
      // only notifications addressed to them can remain.
      const notificationRows = await notifications.deleteForContributor(telegramId);
      // An erasure that matches nothing must still fail loudly — a typo'd id
      // silently "succeeding" would leave the admin believing a GDPR request
      // was fulfilled. (The throw rolls this transaction's zero deletes back.)
      if (roomAdminRows === 0 && notificationRows === 0) {
        throw new WorkflowError(`Contributor ${telegramId} not found — nothing was erased.`);
      }
      return;
    }
    // Log on each task they touched before we unlink authorship. Deliberately
    // no subjectId: a subject pointer here would survive the very erasure it records.
    const seen = new Set<number>();
    for (const app of await applications.listByContributor(telegramId)) {
      if (!seen.has(app.task_id)) {
        await addHistory(app.task_id, 'contributor_forgotten', adminId);
        seen.add(app.task_id);
      }
    }
    // tasks.created_by holds a raw Telegram id (no FK); null it so an admin's
    // stable identifier doesn't survive as PII on tasks they created.
    await run(
      `DELETE FROM submissions WHERE application_id IN (SELECT id FROM applications WHERE contributor_id = $1)`,
      [telegramId],
    );
    await applications.deleteByContributor(telegramId);
    await eraseActor(telegramId); // authorship links, their details (pitches), and admin details naming them
    await run('UPDATE tasks SET created_by = NULL WHERE created_by = $1', [telegramId]);
    // Notifications addressed to them (any status) or about them (subject_id):
    // sent rows retain rendered pitches/names, queued ones would deliver post-erasure.
    await notifications.deleteForContributor(telegramId);
    await contributors.deleteContributor(telegramId);
  });
}

// ---- Read helpers (single service surface for the bot/API layers) ----

export const getTask = tasks.getTask;
export const listTasksByIds = tasks.listByIds;
/**
 * The open board, room-scoped: a room task belongs to its group and never
 * reaches a global discovery surface (global /open, inline search, the Mini App
 * board, announcement fan-out) — only that room's own /open and agent board
 * carry it, alongside the global (no-room) tasks. This is what keeps a
 * stranger's self-registered room from pushing tasks at the whole install
 * base; id-based lookups (/status, deep links, Mini App detail) stay public
 * records so shared links keep working. Pass the room chat id for an in-room
 * surface; omit it for a global one.
 */
export const listOpenTasks = (roomChatId?: number | null): Promise<Task[]> =>
  roomChatId == null ? tasks.listOpenGlobal() : tasks.listOpenForRoom(roomChatId);
export const listDraftTasks = tasks.listDrafts;
export const countDraftTasks = (): Promise<number> => tasks.countByStatus(TaskStatus.Draft);
export const countOpenTasks = (): Promise<number> => tasks.countByStatus(TaskStatus.Open);

/**
 * The task-visibility floor every non-manager surface shares (/status, the
 * agent's get_task, the Mini App): a Draft is never public — an unapproved
 * draft may distill private group chatter no human has released. Open and
 * Closed tasks are public records. Surfaces widen this with their own checks
 * (a manager in a DM, an applicant who engaged with the task) — never below it.
 */
export const isTaskPublic = (task: Pick<Task, 'status'>): boolean => task.status !== TaskStatus.Draft;
/** getTask through the visibility floor: a draft reads as absent. */
export const getPublicTask = async (taskId: number): Promise<Task | undefined> => {
  const task = await tasks.getTask(taskId);
  return task !== undefined && isTaskPublic(task) ? task : undefined;
};
/** The open board with slots taken (two grouped queries); the shared read behind
 *  the Mini App board (global scope) and the agent's list_open_tasks (its room's
 *  scope). Same room-scoping contract as listOpenTasks above. */
export const listOpenTasksWithSlots = async (roomChatId?: number | null): Promise<{ task: Task; assigned: number }[]> => {
  const open = await listOpenTasks(roomChatId);
  const slots = await slotsTakenForTasks(open.map((t) => t.id));
  return open.map((task) => ({ task, assigned: slots.get(task.id) ?? 0 }));
};

export const getApplication = applications.getApplication;
export const listApplicationsByIds = applications.listByIds;
export const getApplicationFor = applications.getApplicationFor;
export const listApplicantsAwaiting = (taskId: number): Promise<Application[]> =>
  applications.listByTaskStatus(taskId, ApplicationStatus.Applied);
/** Pending applications per task (admin /admin overview) — counts only, no pitch rows. */
export const countApplicationsAwaitingPerTask = (): Promise<{ task_id: number; n: number }[]> =>
  applications.countByStatusPerTask(ApplicationStatus.Applied);
export const listAssigned = (taskId: number): Promise<Application[]> =>
  applications.listByTaskStatus(taskId, ApplicationStatus.Assigned);
/** Every assignment in progress, across all tasks — stalest first (admin /active). */
export const listActiveAssignments = (): Promise<Application[]> =>
  applications.listByStatusAll(ApplicationStatus.Assigned);
export const listApplicationsByContributor = applications.listByContributor;
/** Applications still awaiting a decision — the count behind apply()'s per-contributor cap. */
export const countPendingApplications = (contributorId: number): Promise<number> =>
  applications.countByContributorStatus(contributorId, ApplicationStatus.Applied);

/** One row of a contributor's work list: the application plus the task and
 *  latest submission it renders with. */
export interface ApplicationContext {
  application: Application;
  task: Task | undefined;
  latest: Submission | undefined;
}
/**
 * A contributor's applications joined with their tasks and latest submissions —
 * the read every "my work" surface (bot /myapps and /submit, the Mini App, the
 * agent's list_my_applications) shares: three batched queries regardless of
 * list size, the task/submission pair fetched concurrently.
 */
export const applicationsWithContext = async (contributorId: number): Promise<ApplicationContext[]> => {
  const apps = await applications.listByContributor(contributorId);
  if (apps.length === 0) return [];
  const [tasksById, latestByApp] = await Promise.all([
    tasks.listByIds([...new Set(apps.map((a) => a.task_id))]).then((rows) => new Map(rows.map((t) => [t.id, t]))),
    latestSubmissionsByApplication(apps.map((a) => a.id)),
  ]);
  return apps.map((application) => ({
    application,
    task: tasksById.get(application.task_id),
    latest: latestByApp.get(application.id),
  }));
};

// ---- Payouts ----
export type { Payout, PayoutStatus } from './models/payout.js';
/** A contributor's payouts (owed for approved work), newest first. */
export const listPayoutsByContributor = payouts.listByContributor;
/** Payouts in the given statuses (the admin settlement queue reads pending + proposed). */
export const listPayoutsByStatus = payouts.listByStatus;
/** A task's payouts in one status — resolves the /pay target by task id. */
export const listPendingPayoutsForTask = payouts.listPendingByTask;

// ---- DAO-push settlement (PAYOUTS.md) ----

/** How long a 'proposed'+null payout (a claim whose proposal hasn't been seen
 *  on-chain) is held before reconcile auto-resets it to 'pending'. The claim's
 *  only source is the 30s-timeboxed OutLayer submit (single proposer path), so
 *  this covers response-lost-but-landed propagation and RPC node lag with a
 *  wide margin; short enough that a genuinely-failed submit re-enters the queue
 *  within minutes. Replaces the manual reset command — see reconcilePayout. */
const ABANDONED_CLAIM_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/** How long a HEALED claim's memory (receiver+amount on a pending row) keeps
 *  being watched before a complete came-up-empty scan is believed to mean the
 *  failed submit's transaction is dead. A signed NEAR tx embeds a recent block
 *  hash and is only includable for transaction_validity_period blocks (86,400 —
 *  ~a day at worst historical block times), so 48h is ~2x the chain bound.
 *  After expiry the row is a plain pending row again: no more per-reconcile
 *  window scans, and a destination change stops being refused (see
 *  proposePayout's conflicting-claim guard). An identity whose proposal lands
 *  ONLY after this window would have to be re-signed out-of-band — the same
 *  council verify-before-vote residual as any manual proposal. */
const CLAIM_MEMORY_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

/** How long a pinned proposal must have been on the row before a "no such
 *  proposal" read (ERR_NO_PROPOSAL) is believed to mean REMOVED rather than an
 *  RPC node a few blocks behind the one that verified the pin. Well past any
 *  real node lag; a held reconcile retries on the next pass. */
const REMOVED_CONFIRM_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/** Boot-time hook: how to DM a contributor that their payout landed. Registered
 *  by the bot process (src/index.ts) so the settlement rule below announces the
 *  one pending/proposed→paid transition wherever it is observed (/payouts, the
 *  Mini App, /forget's preflight) — no surface re-derives the diff, and the web
 *  tier never imports bot modules. No-op until registered (offline scripts can
 *  exercise the reconciler without DMs); the notifier itself dedups per payout,
 *  so concurrent observers can't double-DM. */
export type PayoutPaidNotifier = (
  contributorId: number,
  taskId: number,
  payoutId: number,
  accountId: string | null,
) => Promise<void>;
let payoutPaidNotifier: PayoutPaidNotifier | null = null;
export function setPayoutPaidNotifier(fn: PayoutPaidNotifier): void {
  payoutPaidNotifier = fn;
}

/** What the DAO says about one payout's proposal right now. */
export interface ProposalChainState {
  /** False when the proposal couldn't be read (RPC failure, DAO unconfigured) —
   *  callers must not treat it as settled. */
  ok: boolean;
  status: payouts.PayoutStatus;
  /** True when the row needs a human: a proposal that Failed on execution
   *  (approved but the transfer bounced — stays 'proposed' pending a
   *  re-finalize, never 'paid'), or a pending row whose last proposal was
   *  voted down (persisted on the row — see payouts.attention). */
  attention: boolean;
  /** True for the benign ok:false cases (no RPC error occurred): a young
   *  'proposed'+null claim whose proposal isn't visible on-chain yet — it
   *  confirms (adopt-by-description) or auto-clears within
   *  ABANDONED_CLAIM_GRACE_MS — or a claim-carrying row whose duplicate scan
   *  couldn't reach proposal #0, so "found nothing" proves nothing. */
  held?: boolean;
  /** The proposal id the row currently points at AFTER reconcile (a just-adopted
   *  id, or the pinned one), so a surface renders the live id instead of the
   *  possibly-stale one on its pre-reconcile snapshot. Null when unproposed. */
  proposalId?: number | null;
  /** More than one LIVE proposal carries this payout's CURRENT identity — an
   *  out-of-band proposal (a council member's own wallet) landing alongside the
   *  bot's. The ledger pins one; the twin is invisible
   *  to every status and would double-pay if the council approves it too. The
   *  council must reject the extra proposal; /forget's audit blocks on it. */
  duplicateProposals?: boolean;
}

/** The authoritative chain-state of a payout row just read under a FOR UPDATE
 *  lock — used when a reconcile compare-and-set LOSES to a concurrent writer:
 *  the row sits in a known, committed state, so surface THAT (ok:true), never the
 *  stale pre-read snapshot. Not "unsure" — we read it locked. */
function committedState(row: payouts.Payout): ProposalChainState {
  return { ok: true, status: row.status, attention: row.attention, proposalId: row.proposal_id };
}

/**
 * The ONE locked compare-and-set every payout settlement write goes through:
 * re-read the row FOR UPDATE, apply `write` only while `guard` still holds —
 * the chain reads that justified the write ran off a snapshot, and a concurrent
 * /pay or reconcile may have pinned, reset, or re-claimed the row since; writing
 * anyway would overwrite a live claim off stale evidence (double-pay). On a
 * lost race the caller gets the locked row back to surface via committedState.
 * `write` runs inside the transaction, so anything it enqueues (the paid DM)
 * commits or rolls back with the row.
 */
async function lockedPayoutApply(
  id: number,
  guard: (fresh: payouts.Payout) => boolean,
  write: (fresh: payouts.Payout) => Promise<void>,
): Promise<'applied' | 'gone' | payouts.Payout> {
  return withTransaction(async () => {
    const fresh = await payouts.getByIdForUpdate(id);
    if (!fresh) return 'gone';
    if (!guard(fresh)) return fresh;
    await write(fresh);
    return 'applied';
  });
}

/** Map a proposal's effective status onto the payout ledger — the single
 *  statement of the DAO settlement rule. `reset` clears the proposal link so the
 *  payout re-enters the queue (window lapsed / moved); the rest advance in place. */
export function proposalToPayout(
  effective: dao.EffectiveStatus,
): { status: payouts.PayoutStatus; reset: boolean; attention: boolean } {
  switch (effective) {
    case 'Executed':
      return { status: 'paid', reset: false, attention: false };
    case 'Failed':
      // Approved but the transfer bounced (e.g. treasury drained) — re-finalizable;
      // hold 'proposed' and flag, never 'paid'.
      return { status: 'proposed', reset: false, attention: true };
    case 'Rejected':
    case 'Removed':
      // Back to the queue, LOUDLY — per PAYOUTS.md ("Rejected | Expired |
      // Removed → pending"). There is deliberately NO terminal "declined" status:
      // it would vanish the row from /payouts with no admin tool to revive it, so
      // a proposal voted down over a mis-entered amount would silently leave
      // approved work unpaid forever. Re-queued, the row stays visible; a council
      // that truly refuses to pay can leave it pending. attention=true so
      // surfaces flag WHY it's back.
      return { status: 'pending', reset: true, attention: true };
    case 'Expired':
    case 'Moved':
      // The window lapsed before approval (or it moved) — re-propose.
      return { status: 'pending', reset: true, attention: false };
    case 'Pending':
      return { status: 'proposed', reset: false, attention: false };
  }
}

/**
 * The SINGLE identity rule for matching an on-chain proposal to a payout:
 * the description is public and predictable (`multiagency payout #<id> task
 * #<id>`), so it is only a lookup hint — the on-chain Transfer must actually pay
 * THIS receiver, THIS amount, in native NEAR. That one check defeats all three
 * attacks at once:
 *   - a FRONT-RUN paying a DIFFERENT account (redirect),
 *   - a right-receiver WRONG-amount proposal (a contributor — who IS the
 *     receiver — inflating their own payout; reconcile passes the pinned
 *     amount so this can't slip through),
 *   - a STALE post-restore description collision (an old payout's different
 *     amount/receiver won't match; an IDENTICAL old one that DID pay is the
 *     same debt, so settling it 'paid' is correct, not a false 'paid').
 * Every place that trusts a proposal id (adopt, the post-submit verify) runs
 * THIS predicate — never the description alone.
 */
function matchesPayoutTransfer(
  p: dao.Proposal,
  description: string,
  receiver: string,
  amountYocto: string | null,
): boolean {
  if (p.description !== description) return false;
  const transfer = (p.kind as Partial<dao.TransferKind>).Transfer;
  if (!transfer) return false;
  if (transfer.receiver_id !== receiver) return false;
  if (transfer.token_id !== '') return false; // pilot: native NEAR only (FT: thread the token id here)
  if (amountYocto != null && transfer.amount !== amountYocto) return false;
  return true;
}

interface RecentProposals {
  page: dao.Proposal[];
  policy: dao.Policy;
  now: number;
  complete: boolean;
}

/** One bounded scan of the recent proposal window. `complete` is true when the
 *  scan reached proposal #0 — when false, a matching proposal could exist beyond
 *  the window, so any path that would MOVE money off "found nothing" (submit a
 *  new Transfer, or heal a claim to 'pending') must fail closed instead. */
async function recentProposals(): Promise<RecentProposals> {
  const WINDOW = 1000;
  // getLastProposalId is the COUNT (one past the newest), so live ids are
  // [0, count) — scan the most recent WINDOW of them: [from, count).
  const count = await dao.getLastProposalId();
  const from = Math.max(0, count - WINDOW);
  if (from > 0) console.warn(`[dao] proposal scan bounded to [${from}, ${count}) — older proposals not checked`);
  const [page, policy] = await Promise.all([dao.getProposals(from, count - from), dao.getPolicy()]);
  return { page, policy, now: Date.now(), complete: from === 0 };
}

/**
 * A lazily-fetched, memoized handle to ONE recent-proposal window, shared by
 * every scan within one operation (a /payouts page, a Mini App load, one /pay,
 * one /forget preflight). The window costs a get_last_proposal_id plus an
 * up-to-1000-proposal page per fetch and is identical for scans seconds apart,
 * so per-operation reuse cuts k scans to one fetch — while every NEW operation
 * still reads a fresh snapshot (no cross-request staleness). Lazy: an operation
 * whose rows never need the chain (paid / never-claimed pending) fetches nothing.
 */
export type ProposalWindow = () => Promise<RecentProposals>;

export function proposalWindow(): ProposalWindow {
  let memo: Promise<RecentProposals> | undefined;
  return () => (memo ??= recentProposals());
}

/**
 * Scan the recent window ONCE and classify it for a payout — the shared basis for
 * BOTH adopt (reconcile) and the propose duplicate-guard, so the identity rule and
 * "newest wins" tie-break can't drift between them:
 *   - `adoptable`: the proposal safe to PIN — identity-matched (matchesPayoutTransfer),
 *     and (propose path, liveOnly) still Pending; newest wins. Reconcile adopts a
 *     live or SETTLED identity match (Pending, Executed orphan → 'paid', Failed →
 *     re-finalizable) but never a DEAD one (Rejected/Expired/Removed/Moved): a
 *     re-proposed payout carries the IDENTICAL identity as its dead predecessor
 *     (same description, receiver, amount), so adopting the corpse would collapse
 *     the fresh claim to 'pending' in one pass — bypassing the abandoned-claim
 *     grace while the real proposal is still mid-submit. Worse, a seen-dead reset
 *     CLEARS the claim memory (resetToPending), so the late-landing real proposal
 *     would then be invisible to reconcile, /pay, and /forget alike (double-pay).
 *     Cost of the exclusion: a claim whose proposal lands AND dies before any
 *     reconcile ever sees it heals via the grace path as a plain re-queue (the
 *     voted-down `attention` flag is lost in that corner) — accepted.
 *   - `liveSameDescription`: every still-Pending proposal carrying this description,
 *     matched or not — a NON-matching live one is a redirect/mismatch the propose
 *     path must refuse rather than submit alongside (double-pay).
 *   - `complete`: whether the scan reached #0 (see recentProposals).
 */
async function scanForPayout(
  description: string,
  receiver: string,
  amountYocto: string | null,
  liveOnly: boolean,
  window: ProposalWindow,
): Promise<{
  adoptable: dao.Proposal | null;
  liveSameDescription: dao.Proposal[];
  liveIdentity: dao.Proposal[];
  complete: boolean;
}> {
  const { page, policy, now, complete } = await window();
  const sameDescription = page.filter((p) => p.description === description);
  const liveSameDescription = sameDescription.filter((p) => dao.effectiveProposalStatus(p, policy, now) === 'Pending');
  const identity = sameDescription.filter((p) => matchesPayoutTransfer(p, description, receiver, amountYocto));
  // Every still-approvable proposal carrying the FULL identity. One is normal;
  // two means the same debt sits before the council twice (an out-of-band
  // proposal alongside the bot's) — "newest wins" pins one and the twin is otherwise invisible,
  // so callers surface >1 as a duplicate hazard rather than staying silent.
  const liveIdentity = identity.filter((p) => dao.effectiveProposalStatus(p, policy, now) === 'Pending');
  const eligible = identity.filter((p) => {
    const s = dao.effectiveProposalStatus(p, policy, now);
    return liveOnly ? s === 'Pending' : s === 'Pending' || s === 'Executed' || s === 'Failed';
  });
  const adoptable = eligible.at(-1) ?? null;
  return { adoptable, liveSameDescription, liveIdentity, complete };
}

/**
 * Reconcile one payout against its DAO `Transfer` proposal — the ONE settlement
 * dispatch every payout surface (/payouts, the Mini App, /forget) uses: the
 * CURRENT claim's reconciler (reconcilePrimary), plus the erasure-grade paid-row
 * audit below when a caller opts in. (A watched SUPERSEDED-claims augment lived
 * here until migration 016: it tracked prior destination identities whose
 * printed CLI command could land a Transfer forever. With the bot as single
 * proposer, an un-landed claim is bounded by tx validity — proposePayout now
 * refuses a destination change while the earlier claim is unresolved, and the
 * claim memory itself expires, so there is nothing left to watch.)
 */
export async function reconcilePayout(
  p: payouts.Payout,
  window: ProposalWindow = proposalWindow(),
  opts?: { auditPaid?: boolean },
): Promise<ProposalChainState> {
  // Dormant rail (no DAO configured — the launch flag-off posture): there is no
  // chain to consult, so the row's committed state is the whole truth. Deciding
  // it HERE keeps every surface honest at once — without it, the reconciler's
  // config throw reads as a phantom "RPC error — try again" that re-running can
  // never fix. /forget does NOT rely on this inert path: its erasure guard has
  // its own in-transaction fail-closed backstops for the config-gap case.
  if (!config.daoContractId) return committedState(p);
  let primary = await reconcilePrimary(p, window);
  // Erasure-grade audit (auditPaid — the /forget preflight): a paid row's
  // display deliberately costs no chain read, but its claim identity may have a
  // still-live TWIN proposal (one proposed out-of-band, one executed) that
  // would pay the same identity AGAIN after the ledger row is erased —
  // unrecorded money to an erased person's account. Before erasure, scan for
  // live identity matches beyond the pinned one, failing closed while unsure
  // (ok:false → the caller's try-again path).
  if (opts?.auditPaid && primary.status === 'paid' && p.account_id && p.amount_yocto) {
    try {
      const scan = await scanForPayout(dao.payoutDescription(p.id, p.task_id), p.account_id, p.amount_yocto, true, window);
      if (!scan.complete) return { ...primary, ok: false };
      if (scan.liveIdentity.some((twin) => twin.id !== p.proposal_id)) {
        primary = { ...primary, duplicateProposals: true };
      }
    } catch {
      return { ...primary, ok: false };
    }
  }
  return primary;
}

/**
 * Reconcile a payout's CURRENT claim against its DAO `Transfer` proposal.
 * `paid` is terminal (no read). A 'proposed' row with no `proposal_id` (a lost
 * post-sign write) is recovered FIRST by matching the payout's on-chain
 * description, so a retry can never double-propose. Otherwise get_proposal →
 * effective status → ledger (see proposalToPayout); transitions persist only off
 * a successful read, and any failure returns ok:false with the stored status
 * untouched so callers refuse money actions while unsure.
 */
async function reconcilePrimary(p: payouts.Payout, window: ProposalWindow): Promise<ProposalChainState> {
  if (p.status === 'paid') return { ok: true, status: p.status, attention: false, proposalId: p.proposal_id };
  try {
    let proposalId = p.proposal_id;
    // Set when the window shows MORE than one live proposal carrying this
    // payout's identity (see scanForPayout.liveIdentity) — an out-of-band
    // proposal alongside the bot's. Detection is best-effort here (display + council warning); the
    // erasure-grade check lives in reconcilePayout's auditPaid.
    let duplicateLive = false;
    // The row's status as of our last authoritative knowledge — advanced past
    // the snapshot when the adopt below pins a proposal (pending → proposed), so
    // the transition dispatch at the bottom compares the mapped status against
    // what the row ACTUALLY is, not a stale pre-adopt snapshot.
    let rowStatus = p.status;
    if (proposalId == null && p.account_id && p.amount_yocto) {
      // Adopt a proposal this row's claim created but never pinned, ONLY if it
      // pays the exact account AND amount the claim was for — never a front-run
      // to another receiver, a self-inflated amount, or a stale post-restore
      // match. Two row states carry that claimed identity:
      //   - 'proposed'+null: a live claim whose id-write was lost (an OutLayer
      //     submit whose pin didn't land or verify);
      //   - 'pending' with claim memory: a HEALED abandoned claim (the heal
      //     keeps receiver/amount — see payouts.resetToPending) whose
      //     unaccounted-for proposal can still land late. If it lands after the
      //     heal, it must be adopted here — otherwise it is invisible to every
      //     surface: a fresh /pay would submit a second Transfer (double-pay)
      //     and /forget would erase past an approvable proposal.
      // A never-claimed pending row has no memory and takes no chain read.
      // A legacy null amount means we can't verify → don't adopt. `complete`
      // gates the heal below.
      const scan = await scanForPayout(dao.payoutDescription(p.id, p.task_id), p.account_id, p.amount_yocto, false, window);
      duplicateLive = scan.liveIdentity.length > 1;
      const found = scan.adoptable;
      if (found) {
        // Pin via the locked CAS. The guard is the FULL claim identity, not
        // status alone: status alone would let a heal + fresh /pay claim slip
        // inside our scan window and have this pin overwrite the new claim's
        // receiver/amount with the old snapshot's, orphaning the new claim's
        // own proposal (double-pay).
        const res = await lockedPayoutApply(
          p.id,
          (fresh) =>
            fresh.status === p.status &&
            fresh.proposal_id == null &&
            fresh.account_id === p.account_id &&
            fresh.amount_yocto === p.amount_yocto,
          () => payouts.markProposed(p.id, found.id, p.account_id!, p.amount_yocto!),
        );
        if (res === 'gone') return { ok: false, status: p.status, attention: false };
        if (res !== 'applied') return committedState(res);
        proposalId = found.id;
        rowStatus = 'proposed';
      }
      // The heal below may reset money-owed state off "found nothing on-chain" —
      // that inference is only sound if the scan reached #0. A truncated scan
      // (complete=false) can't prove no proposal exists beyond the window, so we
      // must NOT heal (or, for watched claim memory, report verified-unstarted)
      // on it; hold instead (see the held return).
      if (proposalId == null && !scan.complete) {
        return { ok: false, status: p.status, attention: false, held: true };
      }
      // Claim-memory expiry: a healed pending row past CLAIM_MEMORY_TTL_MS whose
      // COMPLETE scan still shows nothing carries a claim that is chain-provably
      // dead (tx validity — see the constant). Clear the memory so the row stops
      // paying a window scan on every reconcile and destination changes unblock.
      // Same locked CAS discipline as every settlement write; preserve the
      // row's attention (expiry is not a council signal).
      if (
        proposalId == null &&
        p.status === 'pending' &&
        Date.now() - Date.parse(p.updated_at) > CLAIM_MEMORY_TTL_MS
      ) {
        const res = await lockedPayoutApply(
          p.id,
          (fresh) =>
            fresh.status === 'pending' &&
            fresh.proposal_id == null &&
            fresh.account_id === p.account_id &&
            fresh.amount_yocto === p.amount_yocto &&
            Date.now() - Date.parse(fresh.updated_at) > CLAIM_MEMORY_TTL_MS,
          (fresh) => payouts.resetToPending(p.id, fresh.attention),
        );
        if (res === 'gone') return { ok: false, status: p.status, attention: false };
        if (res !== 'applied') return committedState(res);
        console.log(`[payouts] payout ${p.id}'s claim memory expired (${CLAIM_MEMORY_TTL_MS / 3_600_000}h, nothing on-chain) — cleared`);
        return { ok: true, status: 'pending', attention: p.attention, proposalId: null };
      }
    }
    if (proposalId == null) {
      // A 'pending' row is a verified "not started": never claimed (no chain
      // read needed — no claim, no proposal), or claim memory whose COMPLETE
      // scan above found nothing on-chain right now. The memory stays on the
      // row — the claimed proposal could still land later, so every future
      // reconcile keeps watching. (attention persists a voted-down prior
      // proposal until an admin re-proposes — see resetToPending.)
      if (p.status !== 'proposed') return { ok: true, status: p.status, attention: p.attention, proposalId: null };
      // A 'proposed'+null row with no adoptable proposal is a claim (an OutLayer
      // submit) whose proposal never landed. AUTO-HEAL the
      // abandoned case so no manual reset command is needed: past a grace window
      // (long enough that a promptly-run command isn't reset before its proposal
      // propagates — the complete scan above confirmed none is on-chain), reset it
      // to 'pending' and it re-enters the queue. Within the grace, hold 'proposed'
      // (ok:false + held) so the next reconcile retries and /forget can't erase a
      // claim whose proposal may still be mid-flight.
      if (Date.now() - Date.parse(p.updated_at) > ABANDONED_CLAIM_GRACE_MS) {
        // Same locked CAS as the pin above; the guard re-checks the grace off
        // the LOCKED row, since a concurrent /pay retry or reconcile may have
        // re-claimed (updated_at bumped) or pinned it.
        // keepClaim: nothing was seen on-chain, but a gateway-reported-failed
        // submit can still land late — keep receiver/amount as claim memory so
        // the adopt above recognizes a late-landing proposal (and /forget's
        // guard knows this row needs a chain check before erasure).
        const res = await lockedPayoutApply(
          p.id,
          (fresh) =>
            fresh.status === 'proposed' &&
            fresh.proposal_id == null &&
            Date.now() - Date.parse(fresh.updated_at) > ABANDONED_CLAIM_GRACE_MS,
          () => payouts.resetToPending(p.id, false, true),
        );
        if (res === 'gone') return { ok: false, status: p.status, attention: false };
        if (res !== 'applied') return committedState(res);
        console.warn(`[payouts] payout ${p.id} claimed 'proposed' with no on-chain proposal past the grace — auto-reset to pending`);
        return { ok: true, status: 'pending', attention: false, proposalId: null };
      }
      return { ok: false, status: 'proposed', attention: false, held: true };
    }

    const proposal = await dao.getProposal(proposalId);
    let effective: dao.EffectiveStatus;
    if (!proposal) {
      // "No such proposal" (ERR_NO_PROPOSAL) is how REMOVED actually reads back:
      // Sputnik DELETES a removed proposal from storage rather than marking it,
      // so the `Removed` status literal never survives to a get_proposal — a
      // pinned id that stops existing IS the council's RemoveProposal. Believe it
      // only when (a) the DAO's id counter is already past this id (a node that
      // never saw the proposal reports last <= id, so a lagging node can't pass)
      // and (b) the pin isn't seconds old (belt against reading a different
      // node than the one that verified the pin). Otherwise hold (ok:false) and
      // let the next reconcile retry — never a permanent stall: a truly removed
      // proposal passes both checks on every later pass.
      const last = await dao.getLastProposalId();
      if (proposalId >= last || Date.now() - Date.parse(p.updated_at) <= REMOVED_CONFIRM_GRACE_MS) {
        return { ok: false, status: p.status, attention: false };
      }
      effective = 'Removed';
    } else {
      const policy = await dao.getPolicy();
      effective = dao.effectiveProposalStatus(proposal, policy, Date.now());
    }
    // A pinned row never scans the window on its own — so a live TWIN of the
    // pinned proposal (one proposed out-of-band) would stay invisible
    // right through approval. Check while the danger is real: the pin still
    // approvable (Pending) or just executed (a live twin is then a pure
    // double-pay awaiting one vote). Best-effort: a twin-scan failure must not
    // degrade the successful primary read it rides on (auditPaid fails closed
    // where erasure depends on it).
    if (!duplicateLive && (effective === 'Pending' || effective === 'Executed') && p.account_id && p.amount_yocto) {
      try {
        const twins = await scanForPayout(dao.payoutDescription(p.id, p.task_id), p.account_id, p.amount_yocto, true, window);
        duplicateLive = twins.liveIdentity.some((twin) => twin.id !== proposalId);
      } catch {
        // Display-grade detection only — stay silent rather than fail the read.
      }
    }
    const mapped = proposalToPayout(effective);
    if (mapped.reset || mapped.status !== rowStatus) {
      // Persist the transition via the locked CAS — apply only while the row
      // still shows the exact proposal we reconciled (a concurrent /pay may
      // have re-proposed it since; writing anyway would wipe a live proposal's
      // link and open a double-pay). If it moved on, surface its committed
      // state (a concurrent reconcile already advanced it — authoritative).
      const res = await lockedPayoutApply(
        p.id,
        (fresh) => fresh.status === 'proposed' && fresh.proposal_id === proposalId,
        async () => {
          if (mapped.reset) {
            await payouts.resetToPending(p.id, mapped.attention);
          } else {
            // The one non-reset transition a 'proposed' row can take is → paid
            // (Pending/Failed map back to 'proposed' and never enter this block).
            await payouts.markPaid(p.id);
            // Money just moved, so the owner hears it from us, not by noticing
            // their balance (see PayoutPaidNotifier). The enqueue joins the CAS
            // transaction, so the status flip and the DM commit or roll back
            // together — a notify failure can't strand a silent 'paid', and the
            // CAS itself makes this exactly-once (paid is terminal; a racing
            // reconciler fails the guard). The DM's dedup key covers direct
            // callers of the notifier, not this path.
            await payoutPaidNotifier?.(p.contributor_id, p.task_id, p.id, p.account_id);
          }
        },
      );
      if (res === 'gone') return { ok: false, status: p.status, attention: false };
      if (res !== 'applied') return committedState(res);
      if (mapped.reset && mapped.attention) {
        // The "loudly" in PAYOUTS.md's Rejected→pending rule: a re-queued
        // rejection must be visible in the ops log too, not just flagged on the
        // row (resetToPending persisted attention for the surfaces).
        console.warn(
          `[payouts] proposal ${proposalId} for payout ${p.id} was ${effective} — payout returned to the queue`,
        );
      }
    }
    // duplicateLive stays its OWN flag, never folded into `attention`:
    // attention's meaning (Failed transfer / voted down) drives specific
    // wording on /forget and /payouts, and overloading it would mislabel a
    // duplicate as a failed transfer. Surfaces that only have an attention
    // bit (the Mini App) fold the flag in at their own layer.
    return {
      ok: true,
      status: mapped.status,
      attention: mapped.attention,
      proposalId: mapped.reset ? null : proposalId,
      ...(duplicateLive ? { duplicateProposals: true } : {}),
    };
  } catch {
    return { ok: false, status: p.status, attention: false };
  }
}

/**
 * The pinned on-chain amount a surface may show for a payout, in NEAR — null
 * when nothing current exists to show. The ONE encoding of a settlement-display
 * invariant both /payouts and the Mini App share: key off the RECONCILED
 * status, never the pre-reconcile snapshot. A row reset to 'pending' this very
 * run just had its pin cleared (and a healed row's remembered amount is a dead
 * claim's — see resetToPending), so rendering the snapshot amount would
 * misstate a dead proposal's number as current money. Pending rows show the
 * free-text `reward` instead.
 */
export function pinnedAmountNear(p: payouts.Payout, rec: ProposalChainState): string | null {
  return p.amount_yocto && rec.status !== 'pending' ? dao.formatYoctoNear(p.amount_yocto) : null;
}

/**
 * The money-guard for a typed payout account (no wallet, no signature — see
 * src/near/account.ts): format-check FIRST, before the string is interpolated
 * into any message (an invalid one could carry HTML), then require it to exist
 * on-chain — failing CLOSED when the check itself can't run, so an unreachable
 * RPC reads as "couldn't verify", never as "fine".
 */
async function assertPayableAccount(account: string): Promise<void> {
  if (!isValidAccountId(account)) throw new WorkflowError('That is not a valid NEAR account id.');
  let exists: boolean;
  try {
    exists = await accountExists(account);
  } catch {
    throw new WorkflowError(`Couldn't verify the account on ${config.nearNetwork} right now — try again.`);
  }
  if (!exists) throw new WorkflowError(`Account "${account}" doesn't exist on ${config.nearNetwork}.`);
}

/**
 * Refuse to overwrite a live DIFFERENT-identity claim memory. Until migration
 * 016 this moved the old identity to a watched superseded set instead; with the
 * bot as single proposer an unresolved claim is bounded (its failed submit's tx
 * dies within tx validity, and the memory expires at CLAIM_MEMORY_TTL_MS), so a
 * destination change now simply WAITS out the earlier claim — a bounded refusal
 * beats tracking a second identity forever. Runs inside the same locked
 * transaction as the markProposed it guards, so the check-then-overwrite can't
 * race a concurrent claim.
 */
function assertNoConflictingClaim(row: payouts.Payout, receiver: string, amount: string): void {
  if (row.account_id && row.amount_yocto && (row.account_id !== receiver || row.amount_yocto !== amount)) {
    throw new WorkflowError(
      `Payout #${row.id}'s earlier claim (to ${row.account_id}) is still unresolved — its proposal could ` +
        `still land. Re-run /pay after it settles or clears (within ~48h); /payouts tracks it.`,
    );
  }
}

/**
 * Propose a NEAR payout for a `pending` payout through the DAO. Validates the
 * recipient exists on-chain (typed payout accounts carry no proof, so a free
 * existence read stands in for a signature), builds the `Transfer`, and submits
 * it through the bot's OutLayer TEE wallet (non-custodial — the bot holds no
 * signing key). The TEE wallet is the ONLY proposer the bot offers, by design:
 * it used to print a near-cli fallback command when OutLayer was unset, and
 * that replayable out-of-band command was the root of a whole hazard class —
 * a command run twice minted duplicate live proposals, and a command run hours
 * later was a claim that could never safely expire. With the bot as single
 * proposer, submission is idempotent (the adopt-or-create scan below plus the
 * locked claim); a council member proposing manually from their own wallet is
 * still adopted by identity, and a duplicate of it is flagged by reconcile.
 * `amountYocto` is explicit because `reward` is free text. Not wrapped in a
 * transaction — it spans an external call; the on-chain description is the
 * recovery key if the mark write is lost.
 */
export async function proposePayout(
  payoutId: number,
  receiverAccount: string,
  amountYocto: string,
): Promise<{ proposalId: number } | { submitted: true }> {
  if (!outlayerConfigured()) {
    throw new WorkflowError(
      'On-chain proposing needs the OutLayer TEE wallet (set OUTLAYER_API_KEY) — ' +
        'the payout stays queued; settle it off-platform or configure OutLayer.',
    );
  }
  // Reject anything but a canonical positive integer — including non-canonical
  // zeros like '00'/'000' that a loose \d+ plus a '0' check would let through.
  if (!/^[1-9]\d*$/.test(amountYocto)) {
    throw new WorkflowError('Amount must be a positive yoctoNEAR integer.');
  }
  await assertPayableAccount(receiverAccount);

  // The chain scan below needs the payout's description (its id + task id) —
  // read the row first; a bad id fails here, before any chain read or claim.
  const target = await payouts.getById(payoutId);
  if (!target) throw new WorkflowError(`Payout #${payoutId} not found.`);
  if (target.status === 'paid') throw new WorkflowError(`Payout #${payoutId} is "paid" — nothing to propose.`);
  const description = dao.payoutDescription(payoutId, target.task_id);

  // A pending row carrying claim memory (a healed abandoned claim — see
  // payouts.resetToPending) may have a proposal that landed AFTER the heal (a
  // gateway-reported-failed submit that executed anyway). Settle that through the one
  // shared rule BEFORE proposing anything — otherwise this /pay would submit a
  // second Transfer for a payout the council may already have in front of it,
  // or already paid. The dispatcher itself decides whether a chain read is
  // needed (a never-claimed pending row reconciles for free) — re-encoding the
  // claim-memory predicate here would be a drift seam.
  // One window snapshot serves both the reconcile and the duplicate-guard scan
  // below — the two ran seconds apart against an identical window, and each
  // fetch is a get_last_proposal_id + up-to-1000-proposal page.
  const window = proposalWindow();
  if (target.status === 'pending') {
    const rec = await reconcilePayout(target, window);
    if (!rec.ok) {
      throw new WorkflowError(
        `Payout #${payoutId} has an earlier claim whose on-chain state couldn't be verified — ` +
          `money moves only off a confirmed read; try again shortly.`,
      );
    }
    if (rec.status === 'paid') {
      throw new WorkflowError(
        `Payout #${payoutId} was already paid — its earlier claim's proposal executed on-chain. Nothing to propose.`,
      );
    }
    if (rec.status === 'proposed') {
      const proposalRef = rec.proposalId != null ? `#${rec.proposalId}` : 'from an earlier claim';
      throw new WorkflowError(
        rec.attention
          ? `Payout #${payoutId}'s earlier proposal (${proposalRef}) was approved but the transfer failed — ` +
            `it needs a re-finalize, not a new proposal. Check /payouts.`
          : `Payout #${payoutId} already has a live DAO proposal (${proposalRef}) from an earlier claim — ` +
            `let the council vote on it; /payouts tracks it.`,
      );
    }
    // rec.status === 'pending': any earlier claim's proposal hasn't landed. If
    // the row still carries a DIFFERENT claim identity (a healed abandoned
    // claim's memory, not yet expired), the locked claim below REFUSES the
    // identity switch (assertNoConflictingClaim) — the bounded wait that
    // replaced the watched superseded set (migration 016). A same-identity
    // re-claim proceeds.
  }

  // Scan the chain BEFORE claiming, so a refusal below leaves the row exactly
  // as it was (a 'pending' row stays re-payable — a claim thrown away here
  // would strand it for the whole abandoned-claim grace window).
  //
  // Adopt a proposal that already exists for this payout (recovers a prior lost
  // id-write; idempotent for a retry that only observed 'proposed'). Adopt ONLY
  // a live proposal paying this exact receiver AND amount (the
  // matchesPayoutTransfer identity rule, via the shared scan) — a description
  // match that redirects (front-run) or is stale (post-restore) is never adopted.
  const { adoptable, liveSameDescription, complete } = await scanForPayout(
    description,
    receiverAccount,
    amountYocto,
    true,
    window,
  );
  if (adoptable != null) {
    // Pin under a locked re-check. Never overwrite an already-pinned proposal_id:
    // re-pinning a row whose live proposal we already vouch for would orphan that
    // proposal (still independently approvable) — a double-pay. If the row is
    // already pinned, report THAT id; only fill a null pin (the recovery case).
    const res = await withTransaction(async (): Promise<'settled' | number> => {
      const fresh = await payouts.getByIdForUpdate(payoutId);
      if (!fresh || fresh.status === 'paid') return 'settled';
      if (fresh.proposal_id != null) return fresh.proposal_id;
      assertNoConflictingClaim(fresh, receiverAccount, amountYocto);
      await payouts.markProposed(payoutId, adoptable.id, receiverAccount, amountYocto);
      return adoptable.id;
    });
    if (res === 'settled') throw new WorkflowError(`Payout #${payoutId} is already settled — nothing to propose.`);
    return { proposalId: res };
  }
  // A LIVE proposal already carries this payout's description but pays a
  // different account or amount — a stale prior claim's proposal that landed, or
  // a front-run. Submitting our own alongside it would put TWO live Transfers
  // for one payout in front of the council: approving both is a double-pay.
  // Fail closed and name the blocker (the row is untouched, so once the council
  // rejects it — or it expires — /pay works again).
  if (liveSameDescription.length > 0) {
    throw new WorkflowError(
      `A live DAO proposal (#${liveSameDescription[liveSameDescription.length - 1].id}) already references payout ` +
        `#${payoutId} but pays a different account or amount. Have the council reject it (or let it expire), then ` +
        `/pay again — submitting another now could pay this task twice.`,
    );
  }
  // The scan didn't reach proposal #0, so "no live duplicate found" is NOT
  // proof one doesn't exist beyond the window — submitting could double-pay.
  // Fail closed rather than risk it (the pilot DAO is far under the window; this
  // fires only once the DAO outgrows a single-page scan and needs pagination).
  if (!complete) {
    throw new WorkflowError(
      `Too many DAO proposals to scan safely for a duplicate of payout #${payoutId} — not proposing, to avoid a ` +
        `double-pay. This needs paginated proposal scanning before /pay can run against a DAO this large.`,
    );
  }

  // Claim the row atomically BEFORE the external submit: only the caller who flips
  // pending→proposed submits. This serializes concurrent /pay calls (a second sees
  // 'proposed' and stops above or here), and makes a retry after a lost
  // markProposed write safe — the retry adopts the orphaned proposal by
  // description above rather than submitting a second one (double-pay). The claim
  // also lands the row in 'proposed', so /forget's DAO guard holds an in-flight
  // propose (it fails closed on any 'proposed' row it can't verify settled).
  const claimed = await withTransaction(async (): Promise<boolean> => {
    const p = await payouts.getByIdForUpdate(payoutId);
    if (!p) throw new WorkflowError(`Payout #${payoutId} not found.`);
    if (p.status === 'proposed') return false;
    if (p.status !== 'pending') throw new WorkflowError(`Payout #${payoutId} is "${p.status}" — nothing to propose.`);
    assertNoConflictingClaim(p, receiverAccount, amountYocto);
    await payouts.markProposed(p.id, null, receiverAccount, amountYocto);
    return true;
  });
  if (!claimed) {
    throw new WorkflowError(`Payout #${payoutId} is already being proposed — check /payouts in a moment.`);
  }

  // We hold the claim and no proposal exists yet — submit.
  const kind = dao.transferKind(receiverAccount, amountYocto);
  const bond = (await dao.getPolicy()).proposal_bond;
  let proposalId: number;
  try {
    proposalId = await submitDaoProposal(description, kind, bond);
  } catch (err) {
    // The submit failed at the gateway — but "failed response" does NOT prove
    // the proposal didn't land (a timeout after execution). Do NOT reset the
    // claim: reconcile adopts the proposal by description if it landed, and
    // auto-heals the row to 'pending' within the grace window if it didn't.
    // Tell the admin exactly that instead of a generic failure.
    console.error('[dao] OutLayer submit failed:', err instanceof Error ? err.message : err);
    throw new WorkflowError(
      `The OutLayer submit failed — if the proposal landed anyway, /payouts will pick it up in a moment; ` +
        `otherwise this payout auto-clears back to the queue within minutes. Don't re-run /pay immediately.`,
    );
  }
  // Read back the returned id before pinning it: a buggy/compromised gateway
  // returning a wrong (e.g. stale, already-approved, front-run) id would
  // otherwise settle this payout off an unrelated proposal. The check is the
  // full matchesPayoutTransfer identity (receiver + amount + native token),
  // NEVER the forgeable description alone. If it doesn't match, DON'T pin —
  // leave the row 'proposed'+null so reconcile adopts the real proposal our
  // submit created (it carries our description) by the same validated scan.
  // Fail closed: an unreadable verify also declines to pin.
  let verified = false;
  try {
    const onChain = await dao.getProposal(proposalId);
    verified = onChain != null && matchesPayoutTransfer(onChain, description, receiverAccount, amountYocto);
  } catch {
    verified = false;
  }
  if (verified) {
    // Pin via the same locked CAS as every other settlement write: a
    // concurrent reconcile (a /payouts run, a Mini App load) may have adopted
    // this very proposal by description while we verified — possibly already
    // advanced it to 'paid' (an instant-quorum council). Only fill the null
    // pin our claim left; if the row moved on, its committed state is
    // authoritative and the proposal id we report is the same one either way.
    await lockedPayoutApply(
      payoutId,
      (fresh) => fresh.status === 'proposed' && fresh.proposal_id == null,
      () => payouts.markProposed(payoutId, proposalId, receiverAccount, amountYocto),
    );
    return { proposalId };
  }
  // The returned id didn't verify (wrong/stale gateway response, or an
  // unreadable check). We do NOT pin it — the real proposal our submit created
  // carries our description and will be adopted by reconcile. Report "submitted,
  // confirm via /payouts" rather than printing an id we've proven we can't trust.
  console.warn(`[dao] OutLayer proposal id for payout ${payoutId} didn't verify — leaving it for reconcile to adopt by description`);
  return { submitted: true };
}

/** A contributor's standing DAO-push payout account, or null. */
export async function getPayoutAccount(telegramId: number): Promise<string | null> {
  return (await contributors.getContributor(telegramId))?.payout_account ?? null;
}

/**
 * Set a contributor's standing payout account for the DAO-push model. Typed by the
 * contributor (no wallet/signature — in push they only receive), so we validate it
 * exists on-chain to catch a typo before any treasury Transfer targets it, and fail
 * closed if the check itself can't run. The contributor row must already exist.
 */
export async function setPayoutAccount(telegramId: number, account: string): Promise<void> {
  await assertPayableAccount(account);
  // A zero-row update means the contributor row vanished between the caller's
  // upsert and here — a concurrent /forget. Reporting success would show
  // "saved" for an account that was never stored; fail honestly instead.
  if (!(await contributors.setPayoutAccount(telegramId, account))) {
    throw new WorkflowError('Your account was just erased. Send /start to register again first.');
  }
}

/** The application statuses that consume a task slot: in-progress plus finished work. */
const SLOT_STATUSES = [ApplicationStatus.Assigned, ApplicationStatus.Completed];
/** Slots consumed on a task: in-progress (Assigned) plus finished (Completed) work. */
export const countSlotsTaken = (taskId: number): Promise<number> =>
  applications.countByTaskStatuses(taskId, SLOT_STATUSES);
/** Slots consumed per task for a set of tasks — one grouped query for a listing page. */
const slotsTakenForTasks = async (taskIds: number[]): Promise<Map<number, number>> => {
  const counts = new Map(taskIds.map((id) => [id, 0]));
  for (const row of await applications.countByTaskStatusesForTasks(taskIds, SLOT_STATUSES)) {
    counts.set(row.task_id, row.n);
  }
  return counts;
};
/** Assignments actually in progress — Completed work has left Assigned. */
export const countActiveAssignments = (): Promise<number> =>
  applications.countByStatusAll(ApplicationStatus.Assigned);
/** In-progress assignments with no submission activity for `days` days — the
 *  claim-and-abandon count /admin surfaces (act via /active + /unassign). */
export const countStaleAssignments = (days: number): Promise<number> =>
  applications.countStaleAssigned(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
/** The stale-threshold rows themselves (same predicate as the count) — read by
 *  the worker's pre-stale nudge sweep, which reminds the assignee BEFORE the
 *  assignment reaches /admin's stale count and /unassign territory. */
export const listStaleAssignments = (days: number): Promise<Application[]> =>
  applications.listStaleAssigned(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
/**
 * Aggregate funnel counts for /stats — activation, throughput, and settlement
 * at a glance. Derived entirely from the workflow tables the product already
 * keeps: nothing new is recorded to produce them. This is the measurement
 * layer the launch question ("does this coordinate work?") needs — deeper
 * cuts (cohorts, latency percentiles) stay ad-hoc SQL over task_history.
 */
export async function productStats(): Promise<{
  contributors: number;
  applicants: number;
  tasksTotal: number;
  tasksOpen: number;
  applications: number;
  inProgress: number;
  completed: number;
  payoutsPaid: number;
  payoutsOwed: number;
}> {
  const [contributorCount, applicants, tasksTotal, tasksOpen, applicationCount, inProgress, completed, paid, owedPending, owedProposed] =
    await Promise.all([
      contributors.countAll(),
      applications.countDistinctApplicants(),
      tasks.countAll(),
      tasks.countByStatus(TaskStatus.Open),
      applications.countAll(),
      applications.countByStatusAll(ApplicationStatus.Assigned),
      applications.countByStatusAll(ApplicationStatus.Completed),
      payouts.countByStatus('paid'),
      payouts.countByStatus('pending'),
      payouts.countByStatus('proposed'),
    ]);
  return {
    contributors: contributorCount,
    applicants,
    tasksTotal,
    tasksOpen,
    applications: applicationCount,
    inProgress,
    completed,
    payoutsPaid: paid,
    payoutsOwed: owedPending + owedProposed,
  };
}

/** Ages (whole days) of the oldest rows a contributor is waiting on an ADMIN
 *  for — undecided applications and unreviewed submissions, the two queues
 *  where responsiveness is the product. Null when a queue is empty. /admin
 *  renders these so the operator sees where they are the bottleneck. */
export async function queueAges(): Promise<{ applicationDays: number | null; reviewDays: number | null }> {
  const [appOldest, revOldest] = await Promise.all([
    applications.oldestByStatus(ApplicationStatus.Applied),
    submissions.oldestByStatus(SubmissionStatus.Submitted),
  ]);
  const days = (iso: string | null): number | null =>
    iso === null ? null : Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000));
  return { applicationDays: days(appOldest), reviewDays: days(revOldest) };
}

export const getSubmission = submissions.getSubmission;
export const latestSubmission = submissions.latestForApplication;
/** Latest submission per application for many applications — one query for a listing page. */
export const latestSubmissionsByApplication = async (applicationIds: number[]): Promise<Map<number, Submission>> =>
  new Map((await submissions.latestForApplications(applicationIds)).map((s) => [s.application_id, s]));
export const listSubmissionVersions = submissions.listByApplication;
export const listSubmittedForReview = (): Promise<Submission[]> =>
  submissions.listByStatus(SubmissionStatus.Submitted);
export const countSubmittedForReview = (): Promise<number> =>
  submissions.countByStatus(SubmissionStatus.Submitted);

export const getRoom = rooms.getRoom;
export const isRoomAdmin = rooms.isAdmin;
export const listRoomAdmins = rooms.listAdmins;
/** Room chat ids this user administers — empty means "not a room admin". */
export const listRoomsAdministeredBy = rooms.roomChatIdsForAdmin;
export const signalCountsForRoom = signals.roomCounts;
export type { Room } from './models/room.js';

export const getContributor = contributors.getContributor;
export const listContributorsByIds = contributors.listByIds;
export const getContributorForUpdate = contributors.getContributorForUpdate;
export const listContributorLanguageCodes = contributors.listLanguageCodes;
export const contributorLabel = contributors.contributorLabel;
export type { Contributor } from './models/contributor.js';
export const upsertContributor = contributors.upsertContributor;
export const setAnnounceOptIn = contributors.setAnnounceOptIn;
export const listAnnounceRecipients = contributors.listAnnounceRecipients;
export const notificationCounts = notifications.statusCounts;
export { listHistory, TASK_LEVEL_ACTIONS } from './models/history.js';
