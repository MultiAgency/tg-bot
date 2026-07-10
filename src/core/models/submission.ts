import { db, nowIso } from '../db.js';
import { SubmissionStatus } from '../workflow.js';

export type SubmissionType = 'text' | 'link' | 'file' | 'screenshot' | 'video';

/** The types whose content is a Telegram file_id, delivered as a media message. */
export type MediaSubmissionType = 'file' | 'screenshot' | 'video';

/** True when a submission's content is a file_id to re-send, not text to render. */
export function isMediaSubmission(type: SubmissionType): type is MediaSubmissionType {
  return type === 'file' || type === 'screenshot' || type === 'video';
}

export interface Submission {
  id: number;
  application_id: number;
  version: number;
  type: SubmissionType;
  content: string;
  caption: string | null;
  status: SubmissionStatus;
  reviewer_note: string | null;
  created_at: string;
  updated_at: string;
}

const nextVersionStmt = db.prepare(
  'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM submissions WHERE application_id = ?',
);
const insertStmt = db.prepare(`
  INSERT INTO submissions (application_id, version, type, content, caption, status, created_at, updated_at)
  VALUES (@application_id, @version, @type, @content, @caption, @status, @now, @now)
`);
const getStmt = db.prepare('SELECT * FROM submissions WHERE id = ?');

/** Record a new submission version for an application (v1, v2, …). */
export function createSubmission(
  applicationId: number,
  type: SubmissionType,
  content: string,
  caption: string | null,
): Submission {
  const { v } = nextVersionStmt.get(applicationId) as { v: number };
  const info = insertStmt.run({
    application_id: applicationId,
    version: v,
    type,
    content,
    caption,
    status: SubmissionStatus.Submitted,
    now: nowIso(),
  });
  return getSubmission(Number(info.lastInsertRowid))!;
}

export function getSubmission(id: number): Submission | undefined {
  return getStmt.get(id) as Submission | undefined;
}

const latestStmt = db.prepare(
  'SELECT * FROM submissions WHERE application_id = ? ORDER BY version DESC LIMIT 1',
);
const byApplicationStmt = db.prepare(
  'SELECT * FROM submissions WHERE application_id = ? ORDER BY version ASC',
);

export const latestForApplication = (applicationId: number): Submission | undefined =>
  latestStmt.get(applicationId) as Submission | undefined;
export const listByApplication = (applicationId: number): Submission[] =>
  byApplicationStmt.all(applicationId) as Submission[];

const byStatusStmt = db.prepare(
  'SELECT * FROM submissions WHERE status = ? ORDER BY created_at ASC, id ASC',
);
export const listByStatus = (status: SubmissionStatus): Submission[] =>
  byStatusStmt.all(status) as Submission[];

const countByStatusStmt = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE status = ?');

export const countByStatus = (status: SubmissionStatus): number =>
  (countByStatusStmt.get(status) as { n: number }).n;

const setReviewStmt = db.prepare(`
  UPDATE submissions SET status = @status, reviewer_note = @note, updated_at = @now WHERE id = @id
`);

export function setReview(id: number, status: SubmissionStatus, note: string | null): void {
  setReviewStmt.run({ id, status, note, now: nowIso() });
}
