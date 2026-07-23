import { one, many, run, nowIso } from '../db.js';
import { TaskStatus } from '../workflow.js';

export interface Task {
  id: number;
  title: string;
  description: string;
  reward: string | null;
  deadline: string | null;
  required_output: string | null;
  max_assignees: number;
  status: TaskStatus;
  created_by: number | null;
  room_chat_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface NewTaskInput {
  title: string;
  description: string;
  reward?: string | null;
  deadline?: string | null;
  requiredOutput?: string | null;
  maxAssignees?: number;
  /** null for signal-drafted tasks: the group author never opted into the bot. */
  createdBy: number | null;
  /** The room a signal-drafted task belongs to (room admins may manage it). */
  roomChatId?: number | null;
}

export async function createTask(input: NewTaskInput): Promise<Task> {
  return (await one<Task>(
    `INSERT INTO tasks (title, description, reward, deadline, required_output, max_assignees, status, created_by, room_chat_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING *`,
    [
      input.title,
      input.description,
      input.reward ?? null,
      input.deadline ?? null,
      input.requiredOutput ?? null,
      input.maxAssignees ?? 1,
      TaskStatus.Draft,
      input.createdBy,
      input.roomChatId ?? null,
      nowIso(),
    ],
  ))!;
}

export async function getTask(id: number): Promise<Task | undefined> {
  return one<Task>('SELECT * FROM tasks WHERE id = $1', [id]);
}

/** Fetch many tasks by id in one round trip (listing commands avoid N+1). */
export const listByIds = (ids: number[]): Promise<Task[]> =>
  many<Task>('SELECT * FROM tasks WHERE id = ANY($1)', [ids]);

/**
 * Fetch a task with a row lock (SELECT … FOR UPDATE). Must be called inside a
 * transaction: it serializes concurrent slot-consuming writes to the same task
 * (assignApplication), so two managers can't both read an open slot and oversell.
 */
export async function getTaskForUpdate(id: number): Promise<Task | undefined> {
  return one<Task>('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
}

function listByStatus(status: TaskStatus): Promise<Task[]> {
  return many<Task>('SELECT * FROM tasks WHERE status = $1 ORDER BY created_at ASC, id ASC', [status]);
}

/** The global board: open tasks with no room provenance. A room task belongs to
 *  its group — it never reaches a global discovery surface (see listOpenForRoom). */
export const listOpenGlobal = (): Promise<Task[]> =>
  many<Task>('SELECT * FROM tasks WHERE status = $1 AND room_chat_id IS NULL ORDER BY created_at ASC, id ASC', [
    TaskStatus.Open,
  ]);

/** A room's board: the global tasks plus that room's own. */
export const listOpenForRoom = (roomChatId: number): Promise<Task[]> =>
  many<Task>(
    'SELECT * FROM tasks WHERE status = $1 AND (room_chat_id IS NULL OR room_chat_id = $2) ORDER BY created_at ASC, id ASC',
    [TaskStatus.Open, roomChatId],
  );

export const listDrafts = (): Promise<Task[]> => listByStatus(TaskStatus.Draft);

export async function countByStatus(status: TaskStatus): Promise<number> {
  return (await one<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE status = $1', [status]))!.n;
}

export const countAll = async (): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM tasks'))!.n;

export async function setStatus(id: number, status: TaskStatus): Promise<Task> {
  return (await one<Task>(
    'UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3 RETURNING *',
    [status, nowIso(), id],
  ))!;
}

/** Hard-delete a task row. discardDraft only: a Draft has no public footprint
 *  (no announcement, no applications, no payouts), so the delete is complete —
 *  the caller clears task_history and the drafting signal's FK first. */
export async function deleteTask(id: number): Promise<void> {
  await run('DELETE FROM tasks WHERE id = $1', [id]);
}

/** Group → supergroup migration: re-point task provenance at the successor
 *  chat id (see service.migrateRoomChat for the FK-ordered sequence). */
export async function moveRoom(oldChatId: number, newChatId: number): Promise<number> {
  return run('UPDATE tasks SET room_chat_id = $1 WHERE room_chat_id = $2', [newChatId, oldChatId]);
}
