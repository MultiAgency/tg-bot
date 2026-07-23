import { one, many, run, nowIso } from '../db.js';
import { ApplicationStatus, SubmissionStatus } from '../workflow.js';

export interface Application {
  id: number;
  task_id: number;
  contributor_id: number;
  pitch: string | null;
  status: ApplicationStatus;
  created_at: string;
  updated_at: string;
}

export async function createApplication(
  taskId: number,
  contributorId: number,
  pitch: string | null,
): Promise<Application> {
  return (await one<Application>(
    `INSERT INTO applications (task_id, contributor_id, pitch, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING *`,
    [taskId, contributorId, pitch, ApplicationStatus.Applied, nowIso()],
  ))!;
}

export async function getApplication(id: number): Promise<Application | undefined> {
  return one<Application>('SELECT * FROM applications WHERE id = $1', [id]);
}

/** Fetch many applications by id in one round trip (listing commands avoid N+1). */
export const listByIds = (ids: number[]): Promise<Application[]> =>
  many<Application>('SELECT * FROM applications WHERE id = ANY($1)', [ids]);

/**
 * Fetch an application with a row lock (SELECT … FOR UPDATE). Must be called
 * inside a transaction. Every application mutator takes this lock as its FIRST
 * read: concurrent decisions on the same application (assign vs decline,
 * unassign vs submit, two reviews) serialize on it — under READ COMMITTED both
 * would otherwise pass their status guards and double-apply counter updates.
 */
export async function getApplicationForUpdate(id: number): Promise<Application | undefined> {
  return one<Application>('SELECT * FROM applications WHERE id = $1 FOR UPDATE', [id]);
}

export async function getApplicationFor(taskId: number, contributorId: number): Promise<Application | undefined> {
  return one<Application>('SELECT * FROM applications WHERE task_id = $1 AND contributor_id = $2', [taskId, contributorId]);
}

/**
 * Find AND lock a contributor's application to a task in one round trip (there is
 * at most one — UNIQUE(task_id, contributor_id)). Used by apply()'s re-apply
 * path: a single locked lookup, so the row can't be deleted between an unlocked
 * find and taking the lock (which would drop apply() into a spurious create).
 */
export async function getApplicationForUpdateBy(taskId: number, contributorId: number): Promise<Application | undefined> {
  return one<Application>(
    'SELECT * FROM applications WHERE task_id = $1 AND contributor_id = $2 FOR UPDATE',
    [taskId, contributorId],
  );
}

/**
 * Lock all of a contributor's application rows (ordered, for a stable lock
 * sequence). Erasure takes this FIRST so it acquires application locks before the
 * contributor-row lock — the same app→contributor order every counter-bumping
 * mutator uses, which is what keeps the two from deadlocking (Postgres 40P01).
 */
export async function lockByContributor(contributorId: number): Promise<void> {
  await many('SELECT id FROM applications WHERE contributor_id = $1 ORDER BY id FOR UPDATE', [contributorId]);
}

export const listByTaskStatus = (taskId: number, status: ApplicationStatus): Promise<Application[]> =>
  many<Application>('SELECT * FROM applications WHERE task_id = $1 AND status = $2 ORDER BY created_at ASC, id ASC', [taskId, status]);
export const listByContributor = (contributorId: number): Promise<Application[]> =>
  many<Application>('SELECT * FROM applications WHERE contributor_id = $1 ORDER BY updated_at DESC, id DESC', [contributorId]);

// Global (across all tasks), stalest first — for the admin /active board.
export const listByStatusAll = (status: ApplicationStatus): Promise<Application[]> =>
  many<Application>('SELECT * FROM applications WHERE status = $1 ORDER BY updated_at ASC, id ASC', [status]);

/** COUNT for several statuses at once (e.g. slots taken = assigned + completed) in one round trip. */
export const countByTaskStatuses = async (taskId: number, statuses: ApplicationStatus[]): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM applications WHERE task_id = $1 AND status = ANY($2)', [taskId, statuses]))!.n;
/** Slots taken (assigned + completed) for many tasks at once — one grouped round trip for a listing page. */
export const countByTaskStatusesForTasks = (
  taskIds: number[],
  statuses: ApplicationStatus[],
): Promise<{ task_id: number; n: number }[]> =>
  many<{ task_id: number; n: number }>(
    'SELECT task_id, COUNT(*) AS n FROM applications WHERE task_id = ANY($1) AND status = ANY($2) GROUP BY task_id',
    [taskIds, statuses],
  );
export const countByStatusAll = async (status: ApplicationStatus): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM applications WHERE status = $1', [status]))!.n;
export const countAll = async (): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM applications'))!.n;
export const countDistinctApplicants = async (): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(DISTINCT contributor_id) AS n FROM applications'))!.n;

/**
 * Assignments that look abandoned: still Assigned, untouched since `cutoffIso`,
 * with nothing awaiting review and no submission activity since the cutoff —
 * the claim-and-abandon surface /admin points at (/active lists them stalest
 * first, /unassign frees the slot). An assignment whose latest version is
 * Submitted is a REVIEWER's queue, not the contributor's, so it never counts.
 */
export const countStaleAssigned = async (cutoffIso: string): Promise<number> =>
  (await one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM applications a
     WHERE a.status = $1 AND a.updated_at < $2
       AND NOT EXISTS (
         SELECT 1 FROM submissions s
         WHERE s.application_id = a.id AND (s.status = $3 OR s.created_at >= $2)
       )`,
    [ApplicationStatus.Assigned, cutoffIso, SubmissionStatus.Submitted],
  ))!.n;
export const listStaleAssigned = (cutoffIso: string): Promise<Application[]> =>
  many<Application>(
    `SELECT a.* FROM applications a
     WHERE a.status = $1 AND a.updated_at < $2
       AND NOT EXISTS (
         SELECT 1 FROM submissions s
         WHERE s.application_id = a.id AND (s.status = $3 OR s.created_at >= $2)
       )
     ORDER BY a.updated_at ASC`,
    [ApplicationStatus.Assigned, cutoffIso, SubmissionStatus.Submitted],
  );
/** When the oldest row ENTERED `status` — updated_at, not created_at: reapply()
 *  returns a declined/withdrawn row to Applied without touching created_at, so
 *  created_at would report a fresh re-application as a 60-day-old wait. */
export const oldestByStatus = async (status: ApplicationStatus): Promise<string | null> =>
  (await one<{ oldest: string | null }>('SELECT MIN(updated_at) AS oldest FROM applications WHERE status = $1', [
    status,
  ]))!.oldest;
export const countByStatusPerTask = (status: ApplicationStatus): Promise<{ task_id: number; n: number }[]> =>
  many<{ task_id: number; n: number }>(
    'SELECT task_id, COUNT(*) AS n FROM applications WHERE status = $1 GROUP BY task_id ORDER BY task_id ASC',
    [status],
  );
export const countByContributorStatus = async (contributorId: number, status: ApplicationStatus): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM applications WHERE contributor_id = $1 AND status = $2', [contributorId, status]))!.n;

export async function setStatus(id: number, status: ApplicationStatus): Promise<Application> {
  return (await one<Application>(
    'UPDATE applications SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *',
    [status, nowIso(), id],
  ))!;
}

/** Re-open a declined/withdrawn application with the contributor's new pitch. */
export async function reapply(id: number, pitch: string | null): Promise<Application> {
  return (await one<Application>(
    'UPDATE applications SET status = $1, pitch = $2, updated_at = $3 WHERE id = $4 RETURNING *',
    [ApplicationStatus.Applied, pitch, nowIso(), id],
  ))!;
}

/** Used by erasure: drop all of a contributor's applications. */
export async function deleteByContributor(contributorId: number): Promise<number> {
  return run('DELETE FROM applications WHERE contributor_id = $1', [contributorId]);
}
