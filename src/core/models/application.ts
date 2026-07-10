import { db, nowIso } from '../db.js';
import { ApplicationStatus } from '../workflow.js';

export interface Application {
  id: number;
  task_id: number;
  contributor_id: number;
  pitch: string | null;
  status: ApplicationStatus;
  created_at: string;
  updated_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO applications (task_id, contributor_id, pitch, status, created_at, updated_at)
  VALUES (@task_id, @contributor_id, @pitch, @status, @now, @now)
`);

const getStmt = db.prepare('SELECT * FROM applications WHERE id = ?');
const byTaskContribStmt = db.prepare(
  'SELECT * FROM applications WHERE task_id = ? AND contributor_id = ?',
);

export function createApplication(taskId: number, contributorId: number, pitch: string | null): Application {
  const info = insertStmt.run({
    task_id: taskId,
    contributor_id: contributorId,
    pitch,
    status: ApplicationStatus.Applied,
    now: nowIso(),
  });
  return getApplication(Number(info.lastInsertRowid))!;
}

export function getApplication(id: number): Application | undefined {
  return getStmt.get(id) as Application | undefined;
}

export function getApplicationFor(taskId: number, contributorId: number): Application | undefined {
  return byTaskContribStmt.get(taskId, contributorId) as Application | undefined;
}

const byTaskStatusStmt = db.prepare(
  'SELECT * FROM applications WHERE task_id = ? AND status = ? ORDER BY created_at ASC, id ASC',
);
const byContributorStmt = db.prepare(
  'SELECT * FROM applications WHERE contributor_id = ? ORDER BY updated_at DESC, id DESC',
);

export const listByTaskStatus = (taskId: number, status: ApplicationStatus): Application[] =>
  byTaskStatusStmt.all(taskId, status) as Application[];
export const listByContributor = (contributorId: number): Application[] =>
  byContributorStmt.all(contributorId) as Application[];

// Global (across all tasks), stalest first — for the admin /active board.
const byStatusAllStmt = db.prepare(
  'SELECT * FROM applications WHERE status = ? ORDER BY updated_at ASC, id ASC',
);
export const listByStatusAll = (status: ApplicationStatus): Application[] =>
  byStatusAllStmt.all(status) as Application[];

const countTaskStatusStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM applications WHERE task_id = ? AND status = ?',
);
const countStatusAllStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM applications WHERE status = ?',
);
const countStatusPerTaskStmt = db.prepare(
  'SELECT task_id, COUNT(*) AS n FROM applications WHERE status = ? GROUP BY task_id ORDER BY task_id ASC',
);
const countContribStatusStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM applications WHERE contributor_id = ? AND status = ?',
);

export const countByTaskStatus = (taskId: number, status: ApplicationStatus): number =>
  (countTaskStatusStmt.get(taskId, status) as { n: number }).n;
export const countByStatusAll = (status: ApplicationStatus): number =>
  (countStatusAllStmt.get(status) as { n: number }).n;
export const countByStatusPerTask = (status: ApplicationStatus): { task_id: number; n: number }[] =>
  countStatusPerTaskStmt.all(status) as { task_id: number; n: number }[];
export const countByContributorStatus = (contributorId: number, status: ApplicationStatus): number =>
  (countContribStatusStmt.get(contributorId, status) as { n: number }).n;

const setStatusStmt = db.prepare(
  'UPDATE applications SET status = @status, updated_at = @now WHERE id = @id',
);

export function setStatus(id: number, status: ApplicationStatus): void {
  setStatusStmt.run({ id, status, now: nowIso() });
}

const reapplyStmt = db.prepare(
  'UPDATE applications SET status = @status, pitch = @pitch, updated_at = @now WHERE id = @id',
);

/** Re-open a declined/withdrawn application with the contributor's new pitch. */
export function reapply(id: number, pitch: string | null): void {
  reapplyStmt.run({ id, status: ApplicationStatus.Applied, pitch, now: nowIso() });
}

const clearForContributorStmt = db.prepare(
  'DELETE FROM applications WHERE contributor_id = ?',
);

/** Used by erasure: drop all of a contributor's applications. */
export function deleteByContributor(contributorId: number): number {
  return clearForContributorStmt.run(contributorId).changes;
}
