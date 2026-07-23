import { one, many, run, nowIso } from '../db.js';
import { SubmissionStatus } from '../workflow.js';

export type SubmissionType = 'text' | 'link' | 'file' | 'screenshot' | 'video' | 'video_note';

/** The types whose content is a Telegram file_id, delivered as a media message. */
export type MediaSubmissionType = 'file' | 'screenshot' | 'video' | 'video_note';

/** True when a submission's content is a file_id to re-send, not text to render. */
export function isMediaSubmission(type: SubmissionType): type is MediaSubmissionType {
  return type === 'file' || type === 'screenshot' || type === 'video' || type === 'video_note';
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

/**
 * Record a new submission version for an application (v1, v2, …). Runs inside the
 * caller's transaction (service.submitWork), so the MAX(version)+1 read and the
 * insert are atomic; UNIQUE(application_id, version) backstops any rare race.
 */
export async function createSubmission(
  applicationId: number,
  type: SubmissionType,
  content: string,
  caption: string | null,
): Promise<Submission> {
  const { v } = (await one<{ v: number }>(
    'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM submissions WHERE application_id = $1',
    [applicationId],
  ))!;
  return (await one<Submission>(
    `INSERT INTO submissions (application_id, version, type, content, caption, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     RETURNING *`,
    [applicationId, v, type, content, caption, SubmissionStatus.Submitted, nowIso()],
  ))!;
}

export async function getSubmission(id: number): Promise<Submission | undefined> {
  return one<Submission>('SELECT * FROM submissions WHERE id = $1', [id]);
}

export const latestForApplication = (applicationId: number): Promise<Submission | undefined> =>
  one<Submission>('SELECT * FROM submissions WHERE application_id = $1 ORDER BY version DESC LIMIT 1', [applicationId]);

/** Latest submission per application for a set of applications, in one round trip (listing commands). */
export const latestForApplications = (applicationIds: number[]): Promise<Submission[]> =>
  many<Submission>(
    `SELECT DISTINCT ON (application_id) *
     FROM submissions WHERE application_id = ANY($1)
     ORDER BY application_id, version DESC`,
    [applicationIds],
  );
export const listByApplication = (applicationId: number): Promise<Submission[]> =>
  many<Submission>('SELECT * FROM submissions WHERE application_id = $1 ORDER BY version ASC', [applicationId]);

export const listByStatus = (status: SubmissionStatus): Promise<Submission[]> =>
  many<Submission>('SELECT * FROM submissions WHERE status = $1 ORDER BY created_at ASC, id ASC', [status]);

export const oldestByStatus = async (status: SubmissionStatus): Promise<string | null> =>
  (await one<{ oldest: string | null }>('SELECT MIN(created_at) AS oldest FROM submissions WHERE status = $1', [
    status,
  ]))!.oldest;
export const countByStatus = async (status: SubmissionStatus): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM submissions WHERE status = $1', [status]))!.n;

export async function setReview(id: number, status: SubmissionStatus, note: string | null): Promise<Submission> {
  return (await one<Submission>(
    'UPDATE submissions SET status = $1, reviewer_note = $2, updated_at = $3 WHERE id = $4 RETURNING *',
    [status, note, nowIso(), id],
  ))!;
}
