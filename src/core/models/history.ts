import { one, many, run, nowIso } from '../db.js';

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

/**
 * `subjectId` is the contributor the event is ABOUT (who applied, was assigned,
 * whose work was reviewed) — distinct from the actor who did it. It lets
 * non-admin /status show a contributor the events concerning them without
 * leaking other contributors' outcomes, and erasure null it out.
 */
export async function addHistory(
  taskId: number,
  action: string,
  actorId: number | null,
  detail: string | null = null,
  subjectId: number | null = null,
): Promise<void> {
  await run(
    `INSERT INTO task_history (task_id, action, actor_id, subject_id, detail, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [taskId, action, actorId, subjectId, detail, nowIso()],
  );
}

/**
 * Detail string naming a contributor. The single format `eraseActor` knows how
 * to scrub — always use this when a history detail must reference a contributor.
 */
export function contributorDetail(contributorId: number, reason?: string): string {
  return `contributor ${contributorId}${reason ? `: ${reason}` : ''}`;
}

/** Drop a task's entire audit trail — discardDraft only: a deleted draft's
 *  history would orphan on the tasks FK, and a never-published draft's trail
 *  (its 'created' row) has nothing to audit. */
export async function deleteByTask(taskId: number): Promise<void> {
  await run('DELETE FROM task_history WHERE task_id = $1', [taskId]);
}

// id tiebreaks rows written in the same transaction (identical created_at).
export async function listHistory(taskId: number): Promise<HistoryEntry[]> {
  return many<HistoryEntry>('SELECT * FROM task_history WHERE task_id = $1 ORDER BY created_at ASC, id ASC', [taskId]);
}

/**
 * Used by erasure: scrub a contributor from the audit trail — authorship links,
 * details they authored (e.g. pitches), the subject pointer, and admin-written
 * details naming them ("contributor <id>" / "contributor <id>: <reason>").
 */
export async function eraseActor(actorId: number): Promise<void> {
  await run('UPDATE task_history SET actor_id = NULL, detail = NULL WHERE actor_id = $1', [actorId]);
  await run('UPDATE task_history SET subject_id = NULL WHERE subject_id = $1', [actorId]);
  await run(
    `UPDATE task_history SET detail = '(contributor erased)'
     WHERE detail = 'contributor ' || $1 OR detail LIKE 'contributor ' || $1 || ':%'`,
    [String(actorId)],
  );
}
