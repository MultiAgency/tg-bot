import { db, nowIso } from '../db.js';
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
  createdBy: number;
}

const insertStmt = db.prepare(`
  INSERT INTO tasks (title, description, reward, deadline, required_output, max_assignees, status, created_by, created_at, updated_at)
  VALUES (@title, @description, @reward, @deadline, @required_output, @max_assignees, @status, @created_by, @now, @now)
`);

const getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');

export function createTask(input: NewTaskInput): Task {
  const info = insertStmt.run({
    title: input.title,
    description: input.description,
    reward: input.reward ?? null,
    deadline: input.deadline ?? null,
    required_output: input.requiredOutput ?? null,
    max_assignees: input.maxAssignees ?? 1,
    status: TaskStatus.Draft,
    created_by: input.createdBy,
    now: nowIso(),
  });
  return getTask(Number(info.lastInsertRowid))!;
}

export function getTask(id: number): Task | undefined {
  return getStmt.get(id) as Task | undefined;
}

const byStatusStmt = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC, id ASC');

function listByStatus(status: TaskStatus): Task[] {
  return byStatusStmt.all(status) as Task[];
}

export const listOpen = () => listByStatus(TaskStatus.Open);
export const listDrafts = () => listByStatus(TaskStatus.Draft);

const countByStatusStmt = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ?');

export const countByStatus = (status: TaskStatus): number =>
  (countByStatusStmt.get(status) as { n: number }).n;

const updateStatusStmt = db.prepare('UPDATE tasks SET status = @status, updated_at = @now WHERE id = @id');

export function setStatus(id: number, status: TaskStatus): void {
  updateStatusStmt.run({ id, status, now: nowIso() });
}
