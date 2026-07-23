import { one, many, run, nowIso, withTransaction } from '../db.js';

/**
 * The outbound notification queue. One row = one Telegram message the bot pushes
 * (an announcement, a review alert, an outcome DM…). A single background worker
 * (src/bot/worker.ts) drains it, globally rate-limited, retrying with backoff and
 * recording delivery status. Command *replies* to the acting user do not go here
 * — only bot-initiated pushes, which are the flood-limit surface.
 */

export type NotificationStatus = 'queued' | 'sent' | 'failed';
export type MediaKind = 'photo' | 'document' | 'video' | 'video_note';

export interface NotificationRow {
  id: number;
  dedup_key: string;
  chat_id: string;
  subject_id: number | null;
  text: string | null;
  reply_markup: string | null;
  media_kind: MediaKind | null;
  media_file_id: string | null;
  caption: string | null;
  status: NotificationStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewNotification {
  /** Idempotency key: a second enqueue with the same key is ignored (see enqueue). */
  dedupKey: string;
  chatId: string;
  /**
   * The contributor whose personal data the rendered content carries (their
   * pitch, name, or work), so erasure can purge these rows
   * (service.forgetContributor). Deliberately required: every producer must
   * decide, explicitly — null means "task-only content, names no one"
   * (e.g. channel announcements).
   */
  subjectId: number | null;
  text?: string | null;
  replyMarkup?: string | null;
  mediaKind?: MediaKind | null;
  mediaFileId?: string | null;
  caption?: string | null;
}

// Single source of truth for the notifications INSERT shape, shared by the
// single-row enqueue and the batched enqueueMany so a schema change can't update
// one and silently corrupt the other.
const INSERT_HEAD = `INSERT INTO notifications
  (dedup_key, chat_id, subject_id, text, reply_markup, media_kind, media_file_id, caption,
   status, attempts, next_attempt_at, created_at, updated_at)
  VALUES`;
const ON_CONFLICT = 'ON CONFLICT (dedup_key) DO NOTHING';

/** One VALUES tuple (8 bound columns, literal status/attempts, then `now` for the
 *  three timestamp columns), offset past `base` already-bound params. */
function valuesTuple(base: number): string {
  const p = (i: number): string => `$${base + i}`;
  return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, 'queued', 0, ${p(9)}, ${p(9)}, ${p(9)})`;
}

const INSERT_SQL = `${INSERT_HEAD} ${valuesTuple(0)} ${ON_CONFLICT}`;

function insertParams(n: NewNotification, now: string): unknown[] {
  return [
    n.dedupKey,
    n.chatId,
    n.subjectId,
    n.text ?? null,
    n.replyMarkup ?? null,
    n.mediaKind ?? null,
    n.mediaFileId ?? null,
    n.caption ?? null,
    now,
  ];
}

/**
 * Enqueue a notification. Idempotent on dedupKey: re-enqueuing the same logical
 * message (e.g. a handler that ran twice) inserts nothing. Returns true if a new
 * row was created, false if it was a duplicate.
 */
export async function enqueue(n: NewNotification): Promise<boolean> {
  return (await run(INSERT_SQL, insertParams(n, nowIso()))) > 0;
}

// Rows per multi-row INSERT: 9 params each keeps a chunk far under Postgres's
// 65535-parameter statement limit while still batching a launch-sized fan-out
// into a handful of round trips.
const ENQUEUE_CHUNK = 500;

/**
 * Enqueue many notifications in one transaction (the announcement DM fan-out).
 * Batched into multi-row INSERTs — one round trip per ENQUEUE_CHUNK rows, not
 * per row, so a large fan-out doesn't pin a pool connection for N serial
 * round trips. (ON CONFLICT DO NOTHING is intra-statement-safe: a duplicate
 * dedup_key within one batch is skipped, not an error.)
 */
export async function enqueueMany(rows: NewNotification[]): Promise<number> {
  if (rows.length === 0) return 0;
  const now = nowIso();
  return withTransaction(async () => {
    let inserted = 0;
    for (let at = 0; at < rows.length; at += ENQUEUE_CHUNK) {
      const chunk = rows.slice(at, at + ENQUEUE_CHUNK);
      const params: unknown[] = [];
      const tuples = chunk.map((n) => {
        const base = params.length;
        params.push(...insertParams(n, now));
        return valuesTuple(base);
      });
      inserted += await run(`${INSERT_HEAD} ${tuples.join(', ')} ${ON_CONFLICT}`, params);
    }
    return inserted;
  });
}

/**
 * Queued notifications whose backoff has elapsed (oldest first), for delivery.
 * The NOT EXISTS clause makes per-recipient FIFO structural: a chat's earliest
 * still-queued row is the only claimable one, so a head that is backing off (or
 * was enqueued moments ago) blocks its later siblings — including rows enqueued
 * AFTER the head deferred, which an event-driven defer-on-retry could never
 * reach. At most one row per chat is claimed per pass; the table is pruned to
 * ~30 days, so the self-anti-join stays cheap.
 */
export function claimDue(now: string, limit: number): Promise<NotificationRow[]> {
  return many<NotificationRow>(
    `SELECT * FROM notifications n
     WHERE n.status = 'queued' AND n.next_attempt_at <= $1
       AND NOT EXISTS (
         SELECT 1 FROM notifications p
         WHERE p.chat_id = n.chat_id AND p.status = 'queued' AND p.id < n.id
       )
     ORDER BY n.id LIMIT $2`,
    [now, limit],
  );
}

/**
 * True while a claimed row still exists and is still 'queued'. The worker holds
 * claimed rows in memory across paced sends, and erasure (deleteForContributor)
 * may delete them meanwhile — this is the last-moment check that keeps a purged
 * row from being delivered anyway.
 */
export async function isStillQueued(id: number): Promise<boolean> {
  return (await one(`SELECT 1 AS ok FROM notifications WHERE id = $1 AND status = 'queued'`, [id])) !== undefined;
}

export async function markSent(id: number): Promise<void> {
  await run(`UPDATE notifications SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = $1 WHERE id = $2`, [
    nowIso(),
    id,
  ]);
}

/** Keep the row queued for a later retry after a delivery error (attempts is bumped). */
export async function markRetry(id: number, error: string, nextAttemptAt: string): Promise<void> {
  await run('UPDATE notifications SET attempts = attempts + 1, last_error = $1, next_attempt_at = $2, updated_at = $3 WHERE id = $4', [
    error,
    nextAttemptAt,
    nowIso(),
    id,
  ]);
}

/**
 * A group upgraded to a supergroup: Telegram retired the old chat id and every
 * queued row addressed to it would 400 forever. Point them at the successor id
 * (sent/failed rows keep their historical address).
 */
export async function redirectQueuedChat(oldChatId: string, newChatId: string): Promise<number> {
  return run(`UPDATE notifications SET chat_id = $1, updated_at = $2 WHERE chat_id = $3 AND status = 'queued'`, [
    newChatId,
    nowIso(),
    oldChatId,
  ]);
}

/** Give up after the retry budget is exhausted. */
export async function markFailed(id: number, error: string): Promise<void> {
  await run(`UPDATE notifications SET status = 'failed', attempts = attempts + 1, last_error = $1, updated_at = $2 WHERE id = $3`, [
    error,
    nowIso(),
    id,
  ]);
}

export interface NotificationCounts {
  queued: number;
  retrying: number;
  sent: number;
  failed: number;
}

/** Delivery-status tallies for observability (queued / retrying / sent / failed). */
export async function statusCounts(): Promise<NotificationCounts> {
  return (await one<NotificationCounts>(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued' AND attempts = 0) AS queued,
      COUNT(*) FILTER (WHERE status = 'queued' AND attempts > 0) AS retrying,
      COUNT(*) FILTER (WHERE status = 'sent')                    AS sent,
      COUNT(*) FILTER (WHERE status = 'failed')                  AS failed
    FROM notifications
  `))!;
}

/** Look a notification up by its idempotency key (used by tests/introspection). */
export function findByDedup(dedupKey: string): Promise<NotificationRow | undefined> {
  return one<NotificationRow>('SELECT * FROM notifications WHERE dedup_key = $1', [dedupKey]);
}

/**
 * Ops hygiene: drop sent/failed rows older than the cutoff so the table doesn't
 * grow forever (rendered text is also PII surface area — see subject_id).
 * Queued rows are never pruned. Dedup safety holds: keys are event-scoped and
 * the workflow guards prevent an old event from re-firing after its row is gone.
 */
export async function pruneFinished(beforeIso: string): Promise<number> {
  return run(`DELETE FROM notifications WHERE status IN ('sent', 'failed') AND updated_at < $1`, [beforeIso]);
}

/**
 * Used by erasure: drop every notification addressed to the contributor (their
 * chat) or about them (subject_id) — regardless of delivery status, since sent
 * rows retain the rendered text (pitches, names, work) and their chat id.
 */
export async function deleteForContributor(telegramId: number): Promise<number> {
  return run('DELETE FROM notifications WHERE chat_id = $1 OR subject_id = $2', [String(telegramId), telegramId]);
}
