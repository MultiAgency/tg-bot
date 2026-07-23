import { one, many, run, nowIso } from '../db.js';

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
  /** [DAO] the contributor's standing NEAR payout account (typed, existence-checked
   *  — not proof-backed); null until they set one. See migration 010. */
  payout_account: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Ensure a contributor row exists and refresh their Telegram profile fields.
 * Returns nothing: the hottest caller is the per-update middleware, which never
 * reads the row — callers that need it use getContributor.
 */
export async function upsertContributor(
  telegramId: number,
  username: string | null,
  displayName: string | null,
  languageCode: string | null = null,
): Promise<void> {
  await run(
    `INSERT INTO contributors (telegram_id, username, display_name, language_code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username      = EXCLUDED.username,
       display_name  = EXCLUDED.display_name,
       language_code = EXCLUDED.language_code,
       updated_at    = EXCLUDED.updated_at`,
    [telegramId, username, displayName, languageCode, nowIso()],
  );
}

/** Set a contributor's standing DAO-push payout account (validated by the
 *  service wrapper). Affects an existing row only — callers upsert first.
 *  Returns whether a row matched: false means the contributor vanished between
 *  the caller's upsert and this write (a concurrent /forget) — the caller must
 *  surface that, not report a save that stored nothing. */
export async function setPayoutAccount(telegramId: number, account: string): Promise<boolean> {
  const n = await run('UPDATE contributors SET payout_account = $2, updated_at = $3 WHERE telegram_id = $1', [
    telegramId,
    account,
    nowIso(),
  ]);
  return n > 0;
}

export async function getContributor(telegramId: number): Promise<Contributor | undefined> {
  return one<Contributor>('SELECT * FROM contributors WHERE telegram_id = $1', [telegramId]);
}

/**
 * Fetch a contributor with a row lock (SELECT … FOR UPDATE). Must be called
 * inside a transaction. Erasure (/forget) and the detached notification
 * producers that guard on the contributor's existence (notifyReviewerNote)
 * both take this lock FIRST, so they fully serialize: a note enqueued under
 * the lock commits before erasure starts deleting (and is covered by its
 * notification purge), or the erasure wins and the locked re-read comes back
 * empty — never a post-erasure insert.
 */
export async function getContributorForUpdate(telegramId: number): Promise<Contributor | undefined> {
  return one<Contributor>('SELECT * FROM contributors WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
}

/** Fetch many contributors by telegram id in one round trip (listing commands avoid N+1). */
export const listByIds = (telegramIds: number[]): Promise<Contributor[]> =>
  many<Contributor>('SELECT * FROM contributors WHERE telegram_id = ANY($1)', [telegramIds]);

/** language_code per contributor for a recipient set, in ONE round trip (notification fan-outs). */
export function listLanguageCodes(telegramIds: number[]): Promise<Pick<Contributor, 'telegram_id' | 'language_code'>[]> {
  return many<Pick<Contributor, 'telegram_id' | 'language_code'>>(
    'SELECT telegram_id, language_code FROM contributors WHERE telegram_id = ANY($1)',
    [telegramIds],
  );
}

/** Turn per-contributor task-announcement DMs on or off (default off). */
export async function setAnnounceOptIn(telegramId: number, on: boolean): Promise<void> {
  await run('UPDATE contributors SET announce_opt_in = $1, updated_at = $2 WHERE telegram_id = $3', [
    on ? 1 : 0,
    nowIso(),
    telegramId,
  ]);
}

export const countAll = async (): Promise<number> =>
  (await one<{ n: number }>('SELECT COUNT(*) AS n FROM contributors'))!.n;

/** Contributors who opted in to task-announcement DMs (the fan-out audience). */
export function listAnnounceRecipients(): Promise<Contributor[]> {
  return many<Contributor>('SELECT * FROM contributors WHERE announce_opt_in = 1 ORDER BY created_at ASC');
}

/** Right-to-erasure: remove the contributor's profile row (PII). */
export async function deleteContributor(telegramId: number): Promise<void> {
  await run('DELETE FROM contributors WHERE telegram_id = $1', [telegramId]);
}

async function bump(
  telegramId: number,
  deltas: { applied?: number; assigned?: number; completed?: number; rejected?: number },
): Promise<void> {
  await run(
    `UPDATE contributors
     SET applied_count   = applied_count   + $1,
         assigned_count  = assigned_count  + $2,
         completed_count = completed_count + $3,
         rejected_count  = rejected_count  + $4,
         updated_at = $5
     WHERE telegram_id = $6`,
    [deltas.applied ?? 0, deltas.assigned ?? 0, deltas.completed ?? 0, deltas.rejected ?? 0, nowIso(), telegramId],
  );
}

export const incrementApplied = (id: number): Promise<void> => bump(id, { applied: 1 });
export const incrementAssigned = (id: number): Promise<void> => bump(id, { assigned: 1 });
export const incrementCompleted = (id: number): Promise<void> => bump(id, { completed: 1 });
export const incrementRejected = (id: number): Promise<void> => bump(id, { rejected: 1 });
// Reversing an assignment (unassign / withdraw-while-assigned) undoes its bump,
// so assigned_count reflects assignments still in progress.
export const decrementAssigned = (id: number): Promise<void> => bump(id, { assigned: -1 });

export function contributorLabel(
  c: Pick<Contributor, 'username' | 'display_name' | 'telegram_id'>,
): string {
  if (c.username) return `@${c.username}`;
  if (c.display_name) return c.display_name;
  return `user ${c.telegram_id}`;
}
