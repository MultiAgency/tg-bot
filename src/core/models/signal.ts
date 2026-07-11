import { one, run, nowIso } from '../db.js';

/**
 * A signal is one AI evaluation of a group-chat message in a room that opted in
 * (/enablesignals). Rows deliberately carry NO message text and NO author id —
 * /privacy promises that people who only chat in a group with the bot are never
 * recorded. A row exists for exactly two reasons: it is the unit of the
 * per-room hourly AI budget (created BEFORE the model is called, so concurrent
 * messages can't overdraw it), and it links the Draft task an evaluation
 * produced. `evaluating` rows whose process died before the outcome landed
 * still count against the hour they claimed, then age out of relevance.
 */

export async function createEvaluating(roomChatId: number): Promise<number> {
  return (await one<{ id: number }>(
    `INSERT INTO signals (room_chat_id, score, status, task_id, created_at, updated_at)
     VALUES ($1, NULL, 'evaluating', NULL, $2, $2)
     RETURNING id`,
    [roomChatId, nowIso()],
  ))!.id;
}

/** Evaluations already claimed by this room since `sinceIso` (the rate-limit read). */
export async function countSince(roomChatId: number, sinceIso: string): Promise<number> {
  return (await one<{ n: number }>('SELECT COUNT(*) AS n FROM signals WHERE room_chat_id = $1 AND created_at >= $2', [
    roomChatId,
    sinceIso,
  ]))!.n;
}

export async function finish(
  id: number,
  score: number | null,
  status: 'drafted' | 'discarded',
  taskId: number | null,
): Promise<void> {
  await run(`UPDATE signals SET score = $1, status = $2, task_id = $3, updated_at = $4 WHERE id = $5`, [
    score,
    status,
    taskId,
    nowIso(),
    id,
  ]);
}

/**
 * Flip orphaned 'evaluating' rows to 'discarded'. A row is left 'evaluating'
 * only when the process died between claiming the slot and recording the outcome
 * — an unclean SIGKILL/crash, since a graceful shutdown aborts the model call and
 * discards inline. Safe as a boot-time sweep by the single writer: nothing is
 * legitimately 'evaluating' when the process has only just started. The row
 * already counted against its hour's budget, so this only clears the dangling
 * status; returns how many were cleared.
 */
export async function reclaimEvaluating(): Promise<number> {
  return run(`UPDATE signals SET status = 'discarded', updated_at = $1 WHERE status = 'evaluating'`, [nowIso()]);
}

export interface SignalCounts {
  drafted: number;
  discarded: number;
}

/** Lifetime drafted/discarded tallies for a room (the /signalstatus surface). */
export async function roomCounts(roomChatId: number): Promise<SignalCounts> {
  return (await one<SignalCounts>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'drafted')   AS drafted,
       COUNT(*) FILTER (WHERE status = 'discarded') AS discarded
     FROM signals WHERE room_chat_id = $1`,
    [roomChatId],
  ))!;
}
