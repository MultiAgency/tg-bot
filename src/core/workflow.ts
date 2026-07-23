/**
 * Three independent state machines — one per entity.
 *
 * Task (a unit of work / container):
 *   Draft ──approve──▶ Open ──close──▶ Closed ──reopen──▶ Open
 *
 * Application (a contributor's interest + selection):
 *   Applied ──assign──▶ Assigned          (admin picks, up to task.max_assignees)
 *   Applied ──decline──▶ Declined          (admin passes; re-apply allowed)
 *   Applied ──withdraw──▶ Withdrawn         (contributor pulls out)
 *   Assigned ──withdraw──▶ Withdrawn        (contributor drops after assignment)
 *   Assigned ──unassign──▶ Applied          (admin frees the slot; stays an applicant)
 *   Assigned ──work approved──▶ Completed    (terminal: the slot stays consumed)
 *   Assigned ──work rejected──▶ Rejected     (terminal: slot freed, no re-apply, no re-assign)
 *
 * Completed means assigned, delivered, and the work approved — driven by the
 * submission review, atomically. It is terminal: completed work consumes its
 * slot for good (no withdraw, unassign, re-apply, or re-assign).
 *
 * Declined vs Rejected: Declined means the applicant was not selected;
 * Rejected means they were selected, delivered work, and the work was finally
 * rejected (driven by the submission review, atomically).
 *
 * Submission (the delivered work; each revision is a new version):
 *   Submitted ──approve──▶ Approved
 *   Submitted ──reject──▶ Rejected           (terminal — also closes the assignment)
 *   Submitted ──revise──▶ NeedsRevision      (recoverable — contributor submits a new version)
 */

export const TaskStatus = {
  Draft: 'draft',
  Open: 'open',
  Closed: 'closed',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const ApplicationStatus = {
  Applied: 'applied',
  Assigned: 'assigned',
  Completed: 'completed',
  Declined: 'declined',
  Withdrawn: 'withdrawn',
  Rejected: 'rejected',
} as const;
export type ApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];

export const SubmissionStatus = {
  Submitted: 'submitted',
  NeedsRevision: 'needs_revision',
  Approved: 'approved',
  Rejected: 'rejected',
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** How many contributors one task can have assigned at once. */
export const MAX_ASSIGNEES = 100;

export const isValidMaxAssignees = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= MAX_ASSIGNEES;
