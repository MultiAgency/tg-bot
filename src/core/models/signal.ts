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

/** Evaluations claimed across ALL rooms since `sinceIso` (the global spend cap read). */
export async function countAllSince(sinceIso: string): Promise<number> {
  return (await one<{ n: number }>('SELECT COUNT(*) AS n FROM signals WHERE created_at >= $1', [sinceIso]))!.n;
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

/** A drafted signal whose draft a human then discarded: close it out as
 *  'discarded' — the room tally reports the pipeline's NET outcome, and a
 *  drafted-then-rejected signal produced nothing — and drop the pointer to the
 *  task row being deleted (the FK would block the delete). Score stays: it
 *  measured the message, not the human decision. */
export async function discardDrafted(taskId: number): Promise<void> {
  await run(`UPDATE signals SET status = 'discarded', task_id = NULL, updated_at = $2 WHERE task_id = $1`, [
    taskId,
    nowIso(),
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

/** The room a signal currently belongs to — re-read at draft time because a
 *  chat migration may have moved it since the evaluation began. */
export async function roomOf(signalId: number): Promise<number | undefined> {
  return (await one<{ room_chat_id: number }>('SELECT room_chat_id FROM signals WHERE id = $1', [signalId]))?.room_chat_id;
}

/** Group → supergroup migration: re-point signal history at the successor
 *  chat id (see service.migrateRoomChat for the FK-ordered sequence). */
export async function moveRoom(oldChatId: number, newChatId: number): Promise<number> {
  return run('UPDATE signals SET room_chat_id = $1 WHERE room_chat_id = $2', [newChatId, oldChatId]);
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
