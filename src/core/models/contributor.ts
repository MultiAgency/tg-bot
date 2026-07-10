import { db, nowIso } from '../db.js';

export interface Contributor {
  telegram_id: number;
  username: string | null;
  display_name: string | null;
  language_code: string | null;
  applied_count: number;
  assigned_count: number;
  completed_count: number;
  rejected_count: number;
  announce_opt_in: number;
  created_at: string;
  updated_at: string;
}

const upsertStmt = db.prepare(`
  INSERT INTO contributors (telegram_id, username, display_name, language_code, created_at, updated_at)
  VALUES (@telegram_id, @username, @display_name, @language_code, @now, @now)
  ON CONFLICT(telegram_id) DO UPDATE SET
    username      = excluded.username,
    display_name  = excluded.display_name,
    language_code = excluded.language_code,
    updated_at    = excluded.updated_at
`);

const getStmt = db.prepare('SELECT * FROM contributors WHERE telegram_id = ?');

/**
 * Ensure a contributor row exists and refresh their Telegram profile fields.
 * Returns nothing: the hottest caller is the per-update middleware, which never
 * reads the row — callers that need it use getContributor.
 */
export function upsertContributor(
  telegramId: number,
  username: string | null,
  displayName: string | null,
  languageCode: string | null = null,
): void {
  upsertStmt.run({
    telegram_id: telegramId,
    username,
    display_name: displayName,
    language_code: languageCode,
    now: nowIso(),
  });
}

export function getContributor(telegramId: number): Contributor | undefined {
  return getStmt.get(telegramId) as Contributor | undefined;
}

const optInStmt = db.prepare(
  'UPDATE contributors SET announce_opt_in = @on, updated_at = @now WHERE telegram_id = @telegram_id',
);

/** Turn per-contributor task-announcement DMs on or off (default off). */
export function setAnnounceOptIn(telegramId: number, on: boolean): void {
  optInStmt.run({ telegram_id: telegramId, on: on ? 1 : 0, now: nowIso() });
}

const announceRecipientsStmt = db.prepare(
  'SELECT * FROM contributors WHERE announce_opt_in = 1 ORDER BY created_at ASC',
);

/** Contributors who opted in to task-announcement DMs (the fan-out audience). */
export function listAnnounceRecipients(): Contributor[] {
  return announceRecipientsStmt.all() as Contributor[];
}

const deleteStmt = db.prepare('DELETE FROM contributors WHERE telegram_id = ?');

/** Right-to-erasure: remove the contributor's profile row (PII). */
export function deleteContributor(telegramId: number): void {
  deleteStmt.run(telegramId);
}

const bumpStmt = db.prepare(`
  UPDATE contributors
  SET applied_count   = applied_count   + @applied,
      assigned_count  = assigned_count  + @assigned,
      completed_count = completed_count + @completed,
      rejected_count  = rejected_count  + @rejected,
      updated_at = @now
  WHERE telegram_id = @telegram_id
`);

function bump(
  telegramId: number,
  deltas: { applied?: number; assigned?: number; completed?: number; rejected?: number },
): void {
  bumpStmt.run({
    telegram_id: telegramId,
    applied: deltas.applied ?? 0,
    assigned: deltas.assigned ?? 0,
    completed: deltas.completed ?? 0,
    rejected: deltas.rejected ?? 0,
    now: nowIso(),
  });
}

export const incrementApplied = (id: number) => bump(id, { applied: 1 });
export const incrementAssigned = (id: number) => bump(id, { assigned: 1 });
export const incrementCompleted = (id: number) => bump(id, { completed: 1 });
export const incrementRejected = (id: number) => bump(id, { rejected: 1 });
// Reversing an assignment (unassign / withdraw-while-assigned) undoes its bump,
// so assigned_count reflects assignments still in progress.
export const decrementAssigned = (id: number) => bump(id, { assigned: -1 });

export function contributorLabel(
  c: Pick<Contributor, 'username' | 'display_name' | 'telegram_id'>,
): string {
  if (c.username) return `@${c.username}`;
  if (c.display_name) return c.display_name;
  return `user ${c.telegram_id}`;
}
