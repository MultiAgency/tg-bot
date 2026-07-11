import { withTransaction, run } from './db.js';
import { config } from '../config.js';
import {
  TaskStatus,
  ApplicationStatus,
  SubmissionStatus,
  canTaskTransition,
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
import { addHistory, contributorDetail, eraseActor } from './models/history.js';
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
 * Open → Closed. Stops NEW applications (apply and assign both require an Open
 * task); contributors already assigned can still submit and reviewers can still
 * finish existing work — closing never strands work in progress.
 */
export function closeTask(taskId: number, adminId: number): Promise<Task> {
  return transitionTask(taskId, TaskStatus.Closed, adminId, 'closed');
}

/** Closed → Open (admin reopens). */
export function reopenTask(taskId: number, adminId: number): Promise<Task> {
  return transitionTask(taskId, TaskStatus.Open, adminId, 'reopened');
}

function transitionTask(taskId: number, to: TaskStatus, adminId: number, action: string): Promise<Task> {
  return withTransaction(async (): Promise<Task> => {
    // Lock the task row (see approveTask): serializes concurrent close/reopen on
    // the same task so they can't both pass the transition guard and duplicate history.
    const task = await tasks.getTaskForUpdate(taskId);
    if (!task) throw new WorkflowError(`Task #${taskId} not found.`);
    if (!canTaskTransition(task.status, to)) {
      throw new WorkflowError(`Task #${taskId} is "${task.status}" and cannot become "${to}".`);
    }
    const updated = await tasks.setStatus(task.id, to);
    await addHistory(task.id, action, adminId);
    return updated;
  });
}

// ---- Applications ----

/** A contributor applies to an Open task with an optional pitch. */
export function apply(taskId: number, contributorId: number, pitch: string | null): Promise<Application> {
  return withTransaction(async (): Promise<Application> => {
    // Lock the contributor's existing application for this task first (if any),
    // THEN the task row — the same application→task order assignApplication takes,
    // so apply and assign can never deadlock (the reverse order would). A re-apply
    // mutates the existing row, so this lock also serializes it with concurrent
    // admin decisions on it (assign/decline); the single locked lookup closes the
    // window a find-then-lock pair leaves, where the row is deleted between the two
    // reads (e.g. concurrent erasure) and apply() falls through to a spurious create.
    const existing = await applications.getApplicationForUpdateBy(taskId, contributorId);
    // Lock the task row for the rest of the transaction (like assignApplication):
    // the slot check and the create below must not straddle a concurrent final-slot
    // assignment, or both pass their slot guards under READ COMMITTED and oversell
    // the task — leaving an Applied application on a full task that can only ever
    // error on Assign and needlessly consumes one of the contributor's open slots.
    const task = await tasks.getTaskForUpdate(taskId);
    if (!task) throw new WorkflowError(`Task #${taskId} not found.`);
    if (task.status !== TaskStatus.Open) {
      throw new WorkflowError(`Task #${taskId} is not open for applications.`);
    }
    if ((await countSlotsTaken(taskId)) >= task.max_assignees) {
      throw new WorkflowError(`Task #${taskId} is fully assigned and not accepting applications right now.`);
    }
    if (
      existing &&
      (existing.status === ApplicationStatus.Applied || existing.status === ApplicationStatus.Assigned)
    ) {
      throw new WorkflowError(`You already have an application for task #${taskId}.`);
    }
    if (existing && existing.status === ApplicationStatus.Completed) {
      throw new WorkflowError(`You already completed task #${taskId}. 🎉`);
    }
    if (existing && existing.status === ApplicationStatus.Rejected) {
      // Terminal, unlike Declined — see the workflow.ts header.
      throw new WorkflowError(`Your work for task #${taskId} was rejected — you can't apply to it again.`);
    }
    const open = await applications.countByContributorStatus(contributorId, ApplicationStatus.Applied);
    if (open >= config.maxOpenApplications) {
      throw new WorkflowError(
        `You have ${open} pending applications (max ${config.maxOpenApplications}). Wait for a decision first.`,
      );
    }

    let app: Application;
    if (existing) {
      // Re-apply after a previous decline/withdrawal reuses the row, with the new
      // pitch — and without re-counting: applied_count tracks distinct applications.
      app = await applications.reapply(existing.id, pitch);
    } else {
      // The bot upserts the contributor before this runs, so they normally exist;
      // the only way they don't is a concurrent /forget. Lock-check so that race
      // surfaces as a clean WorkflowError instead of a raw FK violation from the
      // INSERT below (whose contributor FK-lock collides with forget's delete).
      if (!(await contributors.getContributorForUpdate(contributorId))) {
        throw new WorkflowError(`Your account was just erased. Send /start to register again before applying.`);
      }
      app = await applications.createApplication(taskId, contributorId, pitch);
      await contributors.incrementApplied(contributorId);
    }
    await addHistory(taskId, 'applied', contributorId, pitch, contributorId);
    return app;
  });
}

/** Applied → Assigned (admin), if the task still has an open slot. */
export function assignApplication(applicationId: number, adminId: number): Promise<Application> {
  return withTransaction(async (): Promise<Application> => {
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
    return updated;
  });
}

/** Applied → Declined (admin passes on an applicant). */
export function declineApplication(applicationId: number, adminId: number): Promise<Application> {
  return withTransaction(async (): Promise<Application> => {
    const app = await requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Applied) {
      throw new WorkflowError(`Application #${applicationId} is "${app.status}" and cannot be declined.`);
    }
    const updated = await applications.setStatus(app.id, ApplicationStatus.Declined);
    await addHistory(app.task_id, 'declined', adminId, contributorDetail(app.contributor_id), app.contributor_id);
    return updated;
  });
}

/**
 * Assigned → Applied (admin frees the slot; the contributor stays an applicant).
 * The reason is required and preserved in the task history.
 */
export function unassignApplication(applicationId: number, adminId: number, reason: string): Promise<Application> {
  return withTransaction(async (): Promise<Application> => {
    const app = await requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Assigned) {
      throw new WorkflowError(`Application #${applicationId} is not assigned.`);
    }
    await assertNoPendingReview(app);
    const updated = await applications.setStatus(app.id, ApplicationStatus.Applied);
    await contributors.decrementAssigned(app.contributor_id);
    await addHistory(app.task_id, 'unassigned', adminId, contributorDetail(app.contributor_id, reason), app.contributor_id);
    return updated;
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
 * An assigned contributor submits work (a new version). Allowed when there is no
 * prior version, or the latest was sent back for revision.
 */
export function submitWork(
  applicationId: number,
  contributorId: number,
  type: SubmissionType,
  content: string,
  caption: string | null = null,
): Promise<Submission> {
  return withTransaction(async (): Promise<Submission> => {
    const app = await ownApplication(applicationId, contributorId);
    if (app.status !== ApplicationStatus.Assigned) {
      throw new WorkflowError(`You are not assigned to this task.`);
    }
    const latest = await submissions.latestForApplication(app.id);
    if (latest && latest.status === SubmissionStatus.Submitted) {
      throw new WorkflowError(`Your submission is awaiting review — nothing to resubmit yet.`);
    }
    // No Approved or Rejected guard needed: a review decision moves the
    // application to Completed / Rejected in the same transaction (see
    // reviewSubmission), and both are terminal — so an Assigned application
    // can never carry an approved or rejected latest version.
    const sub = await submissions.createSubmission(app.id, type, content, caption);
    await addHistory(app.task_id, 'submitted', contributorId, `v${sub.version} ${type}`, contributorId);
    return sub;
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
): Promise<Submission> {
  return withTransaction(async (): Promise<Submission> => {
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
    if (decision === 'approve') {
      await contributors.incrementCompleted(app.contributor_id);
      await contributors.decrementAssigned(app.contributor_id); // no longer in progress
      await applications.setStatus(app.id, ApplicationStatus.Completed);
      await addHistory(app.task_id, 'completed', reviewerId, contributorDetail(app.contributor_id), app.contributor_id);
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
    return reviewed;
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
  return withTransaction(async (): Promise<DraftedSignal> => {
    const task = await tasks.createTask({
      title: draft.title,
      description: draft.description,
      requiredOutput: draft.requiredOutput,
      createdBy: null,
      roomChatId,
    });
    await addHistory(task.id, 'created', null, `auto-drafted from a group signal (score ${score})`);
    await signals.finish(signalId, score, 'drafted', task.id);
    const room = await rooms.getRoom(roomChatId);
    return { task, roomTitle: room?.title ?? null };
  });
}

// ---- Erasure (right-to-be-forgotten) ----

/** Delete a contributor's PII: their profile, applications, and submissions; anonymize history. */
export function forgetContributor(telegramId: number, adminId: number): Promise<void> {
  return withTransaction(async (): Promise<void> => {
    // Lock this contributor's application rows BEFORE the contributor row — the
    // same app→contributor order every counter-bumping mutator uses (they lock the
    // application via requireApplication, then UPDATE the contributor counters).
    // Taking the contributor lock first here (then locking applications implicitly
    // via deleteByContributor) reverses that order and deadlocks a concurrent
    // assign/review/unassign/withdraw on one of these applications (Postgres 40P01).
    await applications.lockByContributor(telegramId);
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
export const listOpenTasks = tasks.listOpen;
export const listDraftTasks = tasks.listDrafts;
export const countDraftTasks = (): Promise<number> => tasks.countByStatus(TaskStatus.Draft);
export const countOpenTasks = (): Promise<number> => tasks.countByStatus(TaskStatus.Open);

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
/** The application statuses that consume a task slot: in-progress plus finished work. */
const SLOT_STATUSES = [ApplicationStatus.Assigned, ApplicationStatus.Completed];
/** Slots consumed on a task: in-progress (Assigned) plus finished (Completed) work. */
export const countSlotsTaken = (taskId: number): Promise<number> =>
  applications.countByTaskStatuses(taskId, SLOT_STATUSES);
/** Slots consumed per task for a set of tasks — one grouped query for a listing page. */
export const slotsTakenForTasks = async (taskIds: number[]): Promise<Map<number, number>> => {
  const counts = new Map(taskIds.map((id) => [id, 0]));
  for (const row of await applications.countByTaskStatusesForTasks(taskIds, SLOT_STATUSES)) {
    counts.set(row.task_id, row.n);
  }
  return counts;
};
/** Assignments actually in progress — Completed work has left Assigned. */
export const countActiveAssignments = (): Promise<number> =>
  applications.countByStatusAll(ApplicationStatus.Assigned);

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
