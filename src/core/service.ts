import { db } from './db.js';
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

function requireTask(taskId: number): Task {
  const task = tasks.getTask(taskId);
  if (!task) throw new WorkflowError(`Task #${taskId} not found.`);
  return task;
}

function requireApplication(applicationId: number): Application {
  const app = applications.getApplication(applicationId);
  if (!app) throw new WorkflowError(`Application #${applicationId} not found.`);
  return app;
}

/**
 * Fetch an application a contributor owns, or throw. Missing and not-owned raise
 * the *same* message so a contributor can't enumerate others' application ids by
 * probing the id space (unlike requireApplication, whose distinct "not found" is
 * only exposed on admin-gated paths).
 */
function ownApplication(applicationId: number, contributorId: number): Application {
  const app = applications.getApplication(applicationId);
  if (!app || app.contributor_id !== contributorId) {
    throw new WorkflowError(`Application #${applicationId} not found (or not yours).`);
  }
  return app;
}

function requireSubmission(submissionId: number): Submission {
  const sub = submissions.getSubmission(submissionId);
  if (!sub) throw new WorkflowError(`Submission #${submissionId} not found.`);
  return sub;
}

// ---- Tasks ----

export function createTask(input: NewTaskInput): Task {
  const max = input.maxAssignees ?? 1;
  if (!isValidMaxAssignees(max)) {
    throw new WorkflowError(`Max assignees must be a whole number between 1 and ${MAX_ASSIGNEES}.`);
  }
  return db.transaction((): Task => {
    const task = tasks.createTask(input);
    addHistory(task.id, 'created', input.createdBy);
    return task;
  })();
}

/** Draft → Open (the "approve" step). */
export function approveTask(taskId: number, adminId: number): Task {
  return db.transaction((): Task => {
    const task = requireTask(taskId);
    if (task.status !== TaskStatus.Draft) {
      throw new WorkflowError(`Task #${taskId} is "${task.status}" — only drafts can be approved.`);
    }
    tasks.setStatus(task.id, TaskStatus.Open);
    addHistory(task.id, 'approved', adminId);
    return tasks.getTask(task.id)!;
  })();
}

/**
 * Open → Closed. Stops NEW applications (apply and assign both require an Open
 * task); contributors already assigned can still submit and reviewers can still
 * finish existing work — closing never strands work in progress.
 */
export function closeTask(taskId: number, adminId: number): Task {
  return transitionTask(taskId, TaskStatus.Closed, adminId, 'closed');
}

/** Closed → Open (admin reopens). */
export function reopenTask(taskId: number, adminId: number): Task {
  return transitionTask(taskId, TaskStatus.Open, adminId, 'reopened');
}

function transitionTask(taskId: number, to: TaskStatus, adminId: number, action: string): Task {
  return db.transaction((): Task => {
    const task = requireTask(taskId);
    if (!canTaskTransition(task.status, to)) {
      throw new WorkflowError(`Task #${taskId} is "${task.status}" and cannot become "${to}".`);
    }
    tasks.setStatus(task.id, to);
    addHistory(task.id, action, adminId);
    return tasks.getTask(task.id)!;
  })();
}

// ---- Applications ----

/** A contributor applies to an Open task with an optional pitch. */
export function apply(taskId: number, contributorId: number, pitch: string | null): Application {
  return db.transaction((): Application => {
    const task = requireTask(taskId);
    if (task.status !== TaskStatus.Open) {
      throw new WorkflowError(`Task #${taskId} is not open for applications.`);
    }
    if (countSlotsTaken(taskId) >= task.max_assignees) {
      throw new WorkflowError(`Task #${taskId} is fully assigned and not accepting applications right now.`);
    }
    const existing = applications.getApplicationFor(taskId, contributorId);
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
    const open = applications.countByContributorStatus(contributorId, ApplicationStatus.Applied);
    if (open >= config.maxOpenApplications) {
      throw new WorkflowError(
        `You have ${open} pending applications (max ${config.maxOpenApplications}). Wait for a decision first.`,
      );
    }

    let app: Application;
    if (existing) {
      // Re-apply after a previous decline/withdrawal reuses the row, with the new
      // pitch — and without re-counting: applied_count tracks distinct applications.
      applications.reapply(existing.id, pitch);
      app = applications.getApplication(existing.id)!;
    } else {
      app = applications.createApplication(taskId, contributorId, pitch);
      contributors.incrementApplied(contributorId);
    }
    addHistory(taskId, 'applied', contributorId, pitch, contributorId);
    return app;
  })();
}

/** Applied → Assigned (admin), if the task still has an open slot. */
export function assignApplication(applicationId: number, adminId: number): Application {
  return db.transaction((): Application => {
    const app = requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Applied) {
      throw new WorkflowError(`Application #${applicationId} is "${app.status}" and cannot be assigned.`);
    }
    const task = requireTask(app.task_id);
    if (task.status !== TaskStatus.Open) {
      throw new WorkflowError(`Task #${task.id} is not open.`);
    }
    const taken = countSlotsTaken(task.id);
    if (taken >= task.max_assignees) {
      throw new WorkflowError(
        `Task #${task.id} already has ${taken}/${task.max_assignees} assignees.`,
      );
    }
    applications.setStatus(app.id, ApplicationStatus.Assigned);
    contributors.incrementAssigned(app.contributor_id);
    addHistory(task.id, 'assigned', adminId, contributorDetail(app.contributor_id), app.contributor_id);
    return applications.getApplication(app.id)!;
  })();
}

/** Applied → Declined (admin passes on an applicant). */
export function declineApplication(applicationId: number, adminId: number): Application {
  return db.transaction((): Application => {
    const app = requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Applied) {
      throw new WorkflowError(`Application #${applicationId} is "${app.status}" and cannot be declined.`);
    }
    applications.setStatus(app.id, ApplicationStatus.Declined);
    addHistory(app.task_id, 'declined', adminId, contributorDetail(app.contributor_id), app.contributor_id);
    return applications.getApplication(app.id)!;
  })();
}

/**
 * Assigned → Applied (admin frees the slot; the contributor stays an applicant).
 * The reason is required and preserved in the task history.
 */
export function unassignApplication(applicationId: number, adminId: number, reason: string): Application {
  return db.transaction((): Application => {
    const app = requireApplication(applicationId);
    if (app.status !== ApplicationStatus.Assigned) {
      throw new WorkflowError(`Application #${applicationId} is not assigned.`);
    }
    assertNoPendingReview(app);
    applications.setStatus(app.id, ApplicationStatus.Applied);
    contributors.decrementAssigned(app.contributor_id);
    addHistory(app.task_id, 'unassigned', adminId, contributorDetail(app.contributor_id, reason), app.contributor_id);
    return applications.getApplication(app.id)!;
  })();
}

/**
 * An application with work awaiting review may not leave Assigned (withdraw or
 * unassign) — otherwise the submission would stay reviewable while orphaned,
 * and a decision would credit/debit someone no longer assigned. The reviewer
 * resolves the pending version first; then the exit is legal. (Approved work
 * needs no guard here: approval moves the application to Completed in the same
 * transaction, so an Assigned application never carries an approved latest.)
 */
function assertNoPendingReview(app: Application): void {
  const latest = submissions.latestForApplication(app.id);
  if (latest && latest.status === SubmissionStatus.Submitted) {
    throw new WorkflowError(
      `Submission v${latest.version} for task #${app.task_id} is awaiting review — it must be reviewed first.`,
    );
  }
}

/** Applied | Assigned → Withdrawn (contributor pulls out of their own application). */
export function withdrawApplication(applicationId: number, contributorId: number): Application {
  return db.transaction((): Application => {
    const app = ownApplication(applicationId, contributorId);
    if (app.status !== ApplicationStatus.Applied && app.status !== ApplicationStatus.Assigned) {
      throw new WorkflowError(`Application #${applicationId} is "${app.status}" and cannot be withdrawn.`);
    }
    if (app.status === ApplicationStatus.Assigned) {
      assertNoPendingReview(app);
      contributors.decrementAssigned(app.contributor_id);
    }
    applications.setStatus(app.id, ApplicationStatus.Withdrawn);
    addHistory(app.task_id, 'withdrawn', contributorId, null, contributorId);
    return applications.getApplication(app.id)!;
  })();
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
): Submission {
  return db.transaction((): Submission => {
    const app = ownApplication(applicationId, contributorId);
    if (app.status !== ApplicationStatus.Assigned) {
      throw new WorkflowError(`You are not assigned to this task.`);
    }
    const latest = submissions.latestForApplication(app.id);
    if (latest && latest.status === SubmissionStatus.Submitted) {
      throw new WorkflowError(`Your submission is awaiting review — nothing to resubmit yet.`);
    }
    // No Approved or Rejected guard needed: a review decision moves the
    // application to Completed / Rejected in the same transaction (see
    // reviewSubmission), and both are terminal — so an Assigned application
    // can never carry an approved or rejected latest version.
    const sub = submissions.createSubmission(app.id, type, content, caption);
    addHistory(app.task_id, 'submitted', contributorId, `v${sub.version} ${type}`, contributorId);
    return sub;
  })();
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
): Submission {
  return db.transaction((): Submission => {
    const sub = requireSubmission(submissionId);
    if (sub.status !== SubmissionStatus.Submitted) {
      throw new WorkflowError(`Submission #${submissionId} is "${sub.status}" and cannot be reviewed.`);
    }
    const app = requireApplication(sub.application_id);
    submissions.setReview(sub.id, DECISION_STATUS[decision], note);
    addHistory(app.task_id, `review_${decision}`, reviewerId, note, app.contributor_id);
    if (decision === 'approve') {
      contributors.incrementCompleted(app.contributor_id);
      contributors.decrementAssigned(app.contributor_id); // no longer in progress
      applications.setStatus(app.id, ApplicationStatus.Completed);
      addHistory(
        app.task_id,
        'completed',
        reviewerId,
        contributorDetail(app.contributor_id),
        app.contributor_id,
      );
    }
    if (decision === 'reject') {
      contributors.incrementRejected(app.contributor_id);
      contributors.decrementAssigned(app.contributor_id); // no longer in progress
      applications.setStatus(app.id, ApplicationStatus.Rejected);
      addHistory(
        app.task_id,
        'rejected',
        reviewerId,
        contributorDetail(app.contributor_id, note ?? 'submission rejected'),
        app.contributor_id,
      );
    }
    return submissions.getSubmission(sub.id)!;
  })();
}

// ---- Erasure (right-to-be-forgotten) ----

const deleteSubmissionsForContributor = db.prepare(
  `DELETE FROM submissions WHERE application_id IN
     (SELECT id FROM applications WHERE contributor_id = ?)`,
);

// tasks.created_by holds a raw Telegram id (no FK); null it on erasure so an
// admin's stable identifier doesn't survive as PII on tasks they created.
const nullTaskCreators = db.prepare('UPDATE tasks SET created_by = NULL WHERE created_by = ?');

/** Delete a contributor's PII: their profile, applications, and submissions; anonymize history. */
export function forgetContributor(telegramId: number, adminId: number): void {
  db.transaction((): void => {
    // An erasure that matches nothing must fail loudly — a typo'd id silently
    // "succeeding" would leave the admin believing a GDPR request was fulfilled.
    if (!contributors.getContributor(telegramId)) {
      throw new WorkflowError(`Contributor ${telegramId} not found — nothing was erased.`);
    }
    // Log on each task they touched before we unlink authorship. Deliberately
    // no subjectId: a subject pointer here would survive the very erasure it records.
    const seen = new Set<number>();
    for (const app of applications.listByContributor(telegramId)) {
      if (!seen.has(app.task_id)) {
        addHistory(app.task_id, 'contributor_forgotten', adminId);
        seen.add(app.task_id);
      }
    }
    deleteSubmissionsForContributor.run(telegramId);
    applications.deleteByContributor(telegramId);
    eraseActor(telegramId); // authorship links, their details (pitches), and admin details naming them
    nullTaskCreators.run(telegramId); // created_by on any tasks they authored
    // Notifications addressed to them (any status) or about them (subject_id):
    // sent rows retain rendered pitches/names, queued ones would deliver post-erasure.
    notifications.deleteForContributor(telegramId);
    contributors.deleteContributor(telegramId);
  })();
}

// ---- Read helpers (single service surface for the bot/API layers) ----

export const getTask = tasks.getTask;
export const listOpenTasks = tasks.listOpen;
export const listDraftTasks = tasks.listDrafts;
export const countDraftTasks = (): number => tasks.countByStatus(TaskStatus.Draft);
export const countOpenTasks = (): number => tasks.countByStatus(TaskStatus.Open);

export const getApplication = applications.getApplication;
export const getApplicationFor = applications.getApplicationFor;
export const listApplicantsAwaiting = (taskId: number): Application[] =>
  applications.listByTaskStatus(taskId, ApplicationStatus.Applied);
/** Pending applications per task (admin /admin overview) — counts only, no pitch rows. */
export const countApplicationsAwaitingPerTask = (): { task_id: number; n: number }[] =>
  applications.countByStatusPerTask(ApplicationStatus.Applied);
export const listAssigned = (taskId: number): Application[] =>
  applications.listByTaskStatus(taskId, ApplicationStatus.Assigned);
/** Every assignment in progress, across all tasks — stalest first (admin /active). */
export const listActiveAssignments = (): Application[] =>
  applications.listByStatusAll(ApplicationStatus.Assigned);
export const listApplicationsByContributor = applications.listByContributor;
/** Slots consumed on a task: in-progress (Assigned) plus finished (Completed) work. */
export const countSlotsTaken = (taskId: number): number =>
  applications.countByTaskStatus(taskId, ApplicationStatus.Assigned) +
  applications.countByTaskStatus(taskId, ApplicationStatus.Completed);
/** Assignments actually in progress — Completed work has left Assigned. */
export const countActiveAssignments = (): number =>
  applications.countByStatusAll(ApplicationStatus.Assigned);

export const getSubmission = submissions.getSubmission;
export const latestSubmission = submissions.latestForApplication;
export const listSubmissionVersions = submissions.listByApplication;
export const listSubmittedForReview = (): Submission[] =>
  submissions.listByStatus(SubmissionStatus.Submitted);
export const countSubmittedForReview = (): number =>
  submissions.countByStatus(SubmissionStatus.Submitted);

export const getContributor = contributors.getContributor;
export const contributorLabel = contributors.contributorLabel;
export type { Contributor } from './models/contributor.js';
export const upsertContributor = contributors.upsertContributor;
export const setAnnounceOptIn = contributors.setAnnounceOptIn;
export const listAnnounceRecipients = contributors.listAnnounceRecipients;
export const notificationCounts = notifications.statusCounts;
export { listHistory, TASK_LEVEL_ACTIONS } from './models/history.js';
