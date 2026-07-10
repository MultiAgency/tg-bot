import { db, nowIso } from '../db.js';

export interface HistoryEntry {
  id: number;
  task_id: number;
  action: string;
  actor_id: number | null;
  subject_id: number | null;
  detail: string | null;
  created_at: string;
}

/**
 * Actions about the task itself — they name no contributor, so they are safe to
 * show anyone who can see the task. Every other action (applied, assigned,
 * review_* …) concerns a contributor; non-admin views must filter to these plus
 * the viewer's own events. Lives here, next to where actions are recorded, so
 * any future surface (API, web) inherits the same classification.
 */
export const TASK_LEVEL_ACTIONS: ReadonlySet<string> = new Set([
  'created',
  'approved',
  'closed',
  'reopened',
  'contributor_forgotten',
]);

const insertStmt = db.prepare(`
  INSERT INTO task_history (task_id, action, actor_id, subject_id, detail, created_at)
  VALUES (@task_id, @action, @actor_id, @subject_id, @detail, @now)
`);

/**
 * `subjectId` is the contributor the event is ABOUT (who applied, was assigned,
 * whose work was reviewed) — distinct from the actor who did it. It lets
 * non-admin /status show a contributor the events concerning them without
 * leaking other contributors' outcomes, and erasure null it out.
 */
export function addHistory(
  taskId: number,
  action: string,
  actorId: number | null,
  detail: string | null = null,
  subjectId: number | null = null,
): void {
  insertStmt.run({ task_id: taskId, action, actor_id: actorId, subject_id: subjectId, detail, now: nowIso() });
}

/**
 * Detail string naming a contributor. The single format `eraseActor` knows how
 * to scrub — always use this when a history detail must reference a contributor.
 */
export function contributorDetail(contributorId: number, reason?: string): string {
  return `contributor ${contributorId}${reason ? `: ${reason}` : ''}`;
}

// id tiebreaks rows written in the same transaction (identical created_at).
const listStmt = db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at ASC, id ASC');

export function listHistory(taskId: number): HistoryEntry[] {
  return listStmt.all(taskId) as HistoryEntry[];
}

const eraseAuthoredStmt = db.prepare(
  'UPDATE task_history SET actor_id = NULL, detail = NULL WHERE actor_id = ?',
);
// The subject pointer is itself a stable identifier — clear it (detail scrubbing
// below is unchanged; this only removes the structural link).
const eraseSubjectStmt = db.prepare('UPDATE task_history SET subject_id = NULL WHERE subject_id = ?');
// Details written *about* a contributor by admins ("contributor <id>" or
// "contributor <id>: <reason>") — the exact formats service.ts writes.
const eraseMentionsStmt = db.prepare(`
  UPDATE task_history SET detail = '(contributor erased)'
  WHERE detail = 'contributor ' || @id OR detail LIKE 'contributor ' || @id || ':%'
`);

/**
 * Used by erasure: scrub a contributor from the audit trail — authorship links,
 * details they authored (e.g. pitches), and admin-written details naming them.
 */
export function eraseActor(actorId: number): void {
  eraseAuthoredStmt.run(actorId);
  eraseSubjectStmt.run(actorId);
  eraseMentionsStmt.run({ id: String(actorId) });
}
