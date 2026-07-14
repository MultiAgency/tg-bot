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
import * as payouts from './models/payout.js';
import * as walletLink from './models/walletLink.js';
import { getAllocation, getSettlement, type Allocation } from '../near/escrow.js';
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

/**
 * Why applying to `task` would be refused right now, or null when it would be
 * accepted — the single statement of the apply guard chain. apply() enforces it
 * under row locks; advisory surfaces (the agent's propose_apply) evaluate the
 * same chain with plain reads so they never offer an Apply card the mutator
 * would refuse. Messages are user-safe (WorkflowError-grade).
 */
export function applyRefusal(
  task: Task,
  slotsTaken: number,
  existing: Application | undefined,
  pendingApplications: number,
): string | null {
  if (task.status !== TaskStatus.Open) return `Task #${task.id} is not open for applications.`;
  if (slotsTaken >= task.max_assignees) {
    return `Task #${task.id} is fully assigned and not accepting applications right now.`;
  }
  if (existing?.status === ApplicationStatus.Applied || existing?.status === ApplicationStatus.Assigned) {
    return `You already have an application for task #${task.id}.`;
  }
  if (existing?.status === ApplicationStatus.Completed) return `You already completed task #${task.id}. 🎉`;
  if (existing?.status === ApplicationStatus.Rejected) {
    // Terminal, unlike Declined — see the workflow.ts header.
    return `Your work for task #${task.id} was rejected — you can't apply to it again.`;
  }
  if (pendingApplications >= config.maxOpenApplications) {
    return `You have ${pendingApplications} pending applications (max ${config.maxOpenApplications}). Wait for a decision first.`;
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
    // value is re-read below once the serializing locks are held.
    await applications.getApplicationForUpdateBy(taskId, contributorId);
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
    const existing = await applications.getApplicationForUpdateBy(taskId, contributorId);
    const refusal = applyRefusal(
      task,
      await countSlotsTaken(taskId),
      existing,
      await countPendingApplications(contributorId),
    );
    if (refusal) throw new WorkflowError(refusal);

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
    return { application: updated, task };
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
      // The free-text reward is snapshotted; its on-chain amount is resolved when
      // the claim escrow is funded (a later stage). Rewardless tasks record none.
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
  return withTransaction(async (): Promise<DraftedSignal> => {
    const task = await tasks.createTask({
      title: draft.title,
      description: draft.description,
      requiredOutput: draft.requiredOutput,
      deadline: draft.deadline,
      maxAssignees: draft.maxAssignees ?? undefined,
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
export async function forgetContributor(telegramId: number, adminId: number): Promise<void> {
  const fundedError = new WorkflowError(
    `Contributor ${telegramId} has a funded escrow payout awaiting claim — ` +
      `wait for the claim or revoke the allocation (see /payouts), then /forget.`,
  );
  // Money before erasure, checked against the CHAIN — not just the DB status.
  // A funded escrow payout is NEAR already deposited on the claim contract;
  // letting it CASCADE away with the profile would strand it on-chain with no
  // ledger row pointing at it. The DB status is NOT authoritative here: a payout
  // only flips pending→claimable when a reconciler runs (reconcilePayoutOnChain,
  // via /payouts or the Mini App), so between an on-chain `allocate` and that
  // reconciliation a funded payout still reads 'pending'. So when the escrow is
  // configured, ask the chain directly for every still-owed payout — against the
  // account it was OBSERVED funded to when known (pinned at pending→claimable,
  // immune to re-links), else the current link — and refuse if any is funded,
  // failing CLOSED on a read error or a link on a different network than the one
  // we can read (we do not erase while unsure the money is safe). This preflight
  // runs BEFORE the transaction so no DB lock is held across the network read.
  if (config.escrowContractId) {
    const owed = (await payouts.listByContributor(telegramId)).filter(
      (p) => p.status === 'pending' || p.status === 'claimable',
    );
    const link = owed.length > 0 ? await walletLink.getLink(telegramId) : undefined;
    if (link && link.network !== config.nearNetwork) {
      throw new WorkflowError(
        `Contributor ${telegramId}'s wallet link is on "${link.network}" but payouts settle on ` +
          `"${config.nearNetwork}" — their owed payouts can't be verified on-chain, so /forget ` +
          `waits (money before erasure). Settle or revoke their payouts first.`,
      );
    }
    for (const p of owed) {
      const account = p.account_id ?? link?.account_id;
      if (!account) continue; // never linked and never observed funded — nothing reachable on-chain
      let alloc: Allocation | null;
      try {
        alloc = await getAllocation(p.task_id, account);
      } catch {
        throw new WorkflowError(
          `Couldn't confirm the on-chain payout state for contributor ${telegramId} ` +
            `(NEAR RPC unreachable). Money-before-erasure means /forget waits until the ` +
            `check succeeds — try again shortly.`,
        );
      }
      if (alloc) throw fundedError;
    }
  }
  return withTransaction(async (): Promise<void> => {
    // In-transaction backstop: a payout already reconciled to 'claimable' is
    // funded-and-unclaimed. Read under the row lock taken below, so it also closes
    // the race with a concurrent /payouts reconcile; the on-chain preflight above
    // covers the not-yet-reconciled 'pending' window this DB read cannot see.
    if ((await payouts.countByContributorStatus(telegramId, 'claimable')) > 0) {
      throw fundedError;
    }
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
/** The open board — every open task with its slots taken (two grouped queries);
 *  the shared read behind the Mini App board and the agent's list_open_tasks. */
export const listOpenTasksWithSlots = async (): Promise<{ task: Task; assigned: number }[]> => {
  const open = await tasks.listOpen();
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
/** Payouts awaiting funding or claim (the admin queue). */
export const listPayoutsByStatus = payouts.listByStatus;

/** What the chain says about one payout right now. */
export interface PayoutChainState {
  /** False when the chain couldn't be read (RPC failure, escrow unconfigured, an
   *  indeterminate absence) — callers must not offer money actions off it. */
  ok: boolean;
  status: payouts.PayoutStatus;
  /** True when a live allocation sits on-chain right now — Claim should be live. */
  funded: boolean;
  /** yoctoNEAR of the live allocation, when funded. */
  amount?: string;
}

/**
 * Reconcile one payout's stored status against the chain — the single statement
 * of the settlement rule, shared by every surface that reads allocations
 * (/payouts and the Mini App's payouts screen). A live allocation == funded:
 * pending → claimable, pinning the funded account on the row so every later
 * money decision is immune to a wallet re-link. An absent allocation is settled
 * ONLY by the contract's tombstone (get_settlement): Claimed → claimed, Revoked
 * → revoked — never inferred from absence alone, which can't tell a claim from
 * a revoke and is gameable by claiming before our next read. Transitions
 * persist only off successful reads; on any failure — or an absence with no
 * tombstone on a still-claimable row — `ok` is false and the stored status
 * comes back untouched, so callers can refuse money actions while unsure.
 * `claimed` and `revoked` are terminal — no chain read is spent on them.
 */
export async function reconcilePayoutOnChain(
  p: payouts.Payout,
  linkedAccountId: string | undefined,
): Promise<PayoutChainState> {
  if (p.status === 'claimed' || p.status === 'revoked') return { ok: true, status: p.status, funded: false };
  // The pinned funded account wins; the current link only seeds first observation.
  const account = p.account_id ?? linkedAccountId;
  if (!account) return { ok: false, status: p.status, funded: false };
  try {
    const alloc = await getAllocation(p.task_id, account);
    if (alloc) {
      if (p.status === 'pending' || !p.account_id) await payouts.markFunded(p.id, account);
      return { ok: true, status: 'claimable', funded: true, amount: alloc.amount };
    }
    const settlement = await getSettlement(p.task_id, account);
    if (settlement === 'Claimed') {
      await payouts.setStatus(p.id, 'claimed');
      return { ok: true, status: 'claimed', funded: false };
    }
    if (settlement === 'Revoked') {
      await payouts.setStatus(p.id, 'revoked');
      return { ok: true, status: 'revoked', funded: false };
    }
    // No allocation and no tombstone: for a pending row that's a verified
    // "never funded"; for a claimable row it's indeterminate (a claim's
    // callback still in flight, or a contract predating tombstones) — hold the
    // stored status and report unverified.
    return p.status === 'pending'
      ? { ok: true, status: 'pending', funded: false }
      : { ok: false, status: p.status, funded: false };
  } catch {
    return { ok: false, status: p.status, funded: false };
  }
}

// ---- Wallet links (NEAR account ↔ Telegram identity) ----
export type { WalletLink } from './models/walletLink.js';
export const getWalletLink = walletLink.getLink;

/**
 * The contributor's wallet link only when it is on the bot's configured NEAR
 * network. Money surfaces (funding queue, reconciliation, claims) must not act
 * on a link proved on a different chain: a mainnet `allocate` to a
 * testnet-only account name deposits into an allocation no one can ever claim.
 */
export async function payableWalletLink(contributorId: number): Promise<walletLink.WalletLink | undefined> {
  const link = await walletLink.getLink(contributorId);
  return link && link.network === config.nearNetwork ? link : undefined;
}

/**
 * Record a verified wallet link (the caller has already checked the NEP-413
 * proof). Two money guards beyond the raw upsert:
 *  - Re-linking to a DIFFERENT account is refused while any owed payout is (or
 *    might be) funded to the outgoing one: each pending/claimable payout is
 *    checked on-chain against its pinned account or the outgoing link, failing
 *    CLOSED on read errors and network mismatches. Without this, the funded
 *    allocation goes invisible — a false settlement, a double-fund to the new
 *    account, and an erasure guard that can no longer see the money.
 *  - One NEAR account per contributor per network (unique index, migration
 *    007): shared wallets would collide on the contract's (task, account) key,
 *    letting one payment satisfy two ledger rows.
 * With the escrow unconfigured the re-link is allowed: the product can neither
 * print fund commands nor read the chain, so no allocation can be keyed to the
 * outgoing link through it.
 */
export async function upsertWalletLink(
  contributorId: number,
  accountId: string,
  publicKey: string,
  network: string,
): Promise<void> {
  const existing = await walletLink.getLink(contributorId);
  const changingAccount = existing && (existing.account_id !== accountId || existing.network !== network);
  if (changingAccount && config.escrowContractId) {
    const owed = (await payouts.listByContributor(contributorId)).filter(
      (p) => p.status === 'pending' || p.status === 'claimable',
    );
    if (owed.length > 0 && existing.network !== config.nearNetwork) {
      throw new WorkflowError(
        `Your current link is on "${existing.network}" but payouts settle on "${config.nearNetwork}" — ` +
          `ask an admin to settle your owed payouts before linking a different wallet.`,
      );
    }
    for (const p of owed) {
      const account = p.account_id ?? existing.account_id;
      let alloc: Allocation | null;
      try {
        alloc = await getAllocation(p.task_id, account);
      } catch {
        throw new WorkflowError(
          `Couldn't verify your owed payouts on-chain just now — try linking again shortly.`,
        );
      }
      if (alloc) {
        throw new WorkflowError(
          `A payout for task #${p.task_id} is already funded on-chain to ${account} — claim it with ` +
            `that wallet (or ask an admin to revoke it) before linking a different one.`,
        );
      }
    }
  }
  try {
    await walletLink.upsertLink(contributorId, accountId, publicKey, network);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new WorkflowError('That NEAR account is already linked to another contributor.');
    }
    throw err;
  }
}
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
