import { db, nowIso } from '../db.js';

/**
 * The outbound notification queue. One row = one Telegram message the bot pushes
 * (an announcement, a review alert, an outcome DM…). A single background worker
 * (src/bot/worker.ts) drains it, globally rate-limited, retrying with backoff and
 * recording delivery status. Command *replies* to the acting user do not go here
 * — only bot-initiated pushes, which are the flood-limit surface.
 */

export type NotificationStatus = 'queued' | 'sent' | 'failed';
export type MediaKind = 'photo' | 'document' | 'video';

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

const insertStmt = db.prepare(`
  INSERT INTO notifications
    (dedup_key, chat_id, subject_id, text, reply_markup, media_kind, media_file_id, caption,
     status, attempts, next_attempt_at, created_at, updated_at)
  VALUES
    (@dedup_key, @chat_id, @subject_id, @text, @reply_markup, @media_kind, @media_file_id, @caption,
     'queued', 0, @now, @now, @now)
  ON CONFLICT(dedup_key) DO NOTHING
`);

function toRow(n: NewNotification, now: string): Record<string, unknown> {
  return {
    dedup_key: n.dedupKey,
    chat_id: n.chatId,
    subject_id: n.subjectId,
    text: n.text ?? null,
    reply_markup: n.replyMarkup ?? null,
    media_kind: n.mediaKind ?? null,
    media_file_id: n.mediaFileId ?? null,
    caption: n.caption ?? null,
    now,
  };
}

/**
 * Enqueue a notification. Idempotent on dedupKey: re-enqueuing the same logical
 * message (e.g. a handler that ran twice) inserts nothing. Returns true if a new
 * row was created, false if it was a duplicate.
 */
export function enqueue(n: NewNotification): boolean {
  return insertStmt.run(toRow(n, nowIso())).changes > 0;
}

const enqueueManyTxn = db.transaction((rows: NewNotification[], now: string): number => {
  let inserted = 0;
  for (const n of rows) inserted += insertStmt.run(toRow(n, now)).changes;
  return inserted;
});

/** Enqueue many notifications in one transaction (the announcement DM fan-out). */
export function enqueueMany(rows: NewNotification[]): number {
  return enqueueManyTxn(rows, nowIso());
}

const claimStmt = db.prepare(`
  SELECT * FROM notifications
  WHERE status = 'queued' AND next_attempt_at <= @now
  ORDER BY id
  LIMIT @limit
`);

/** Queued notifications whose backoff has elapsed (oldest first), for delivery. */
export function claimDue(now: string, limit: number): NotificationRow[] {
  return claimStmt.all({ now, limit }) as NotificationRow[];
}

const stillQueuedStmt = db.prepare(`SELECT 1 FROM notifications WHERE id = ? AND status = 'queued'`);
/**
 * True while a claimed row still exists and is still 'queued'. The worker holds
 * claimed rows in memory across paced sends, and erasure (deleteForContributor)
 * may delete them meanwhile — this is the last-moment check that keeps a purged
 * row from being delivered anyway.
 */
export function isStillQueued(id: number): boolean {
  return stillQueuedStmt.get(id) !== undefined;
}

const markSentStmt = db.prepare(
  `UPDATE notifications SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = @now WHERE id = @id`,
);
export function markSent(id: number): void {
  markSentStmt.run({ id, now: nowIso() });
}

const markRetryStmt = db.prepare(
  `UPDATE notifications SET attempts = attempts + 1, last_error = @error, next_attempt_at = @next, updated_at = @now WHERE id = @id`,
);
/** Keep the row queued for a later retry after a delivery error (attempts is bumped). */
export function markRetry(id: number, error: string, nextAttemptAt: string): void {
  markRetryStmt.run({ id, error, next: nextAttemptAt, now: nowIso() });
}

const markFailedStmt = db.prepare(
  `UPDATE notifications SET status = 'failed', attempts = attempts + 1, last_error = @error, updated_at = @now WHERE id = @id`,
);
/** Give up after the retry budget is exhausted. */
export function markFailed(id: number, error: string): void {
  markFailedStmt.run({ id, error, now: nowIso() });
}

const countsStmt = db.prepare(`
  SELECT
    COALESCE(SUM(status = 'queued' AND attempts = 0), 0) AS queued,
    COALESCE(SUM(status = 'queued' AND attempts > 0), 0) AS retrying,
    COALESCE(SUM(status = 'sent'), 0)                    AS sent,
    COALESCE(SUM(status = 'failed'), 0)                  AS failed
  FROM notifications
`);

export interface NotificationCounts {
  queued: number;
  retrying: number;
  sent: number;
  failed: number;
}

/** Delivery-status tallies for observability (queued / retrying / sent / failed). */
export function statusCounts(): NotificationCounts {
  return countsStmt.get() as NotificationCounts;
}

const byDedupStmt = db.prepare('SELECT * FROM notifications WHERE dedup_key = ?');
/** Look a notification up by its idempotency key (used by tests/introspection). */
export function findByDedup(dedupKey: string): NotificationRow | undefined {
  return byDedupStmt.get(dedupKey) as NotificationRow | undefined;
}

const pruneFinishedStmt = db.prepare(
  `DELETE FROM notifications WHERE status IN ('sent', 'failed') AND updated_at < ?`,
);
/**
 * Ops hygiene: drop sent/failed rows older than the cutoff so the table doesn't
 * grow forever (rendered text is also PII surface area — see subject_id).
 * Queued rows are never pruned. Dedup safety holds: keys are event-scoped and
 * the workflow guards prevent an old event from re-firing after its row is gone.
 */
export function pruneFinished(beforeIso: string): number {
  return pruneFinishedStmt.run(beforeIso).changes;
}

const deleteForContributorStmt = db.prepare(
  'DELETE FROM notifications WHERE chat_id = @chat OR subject_id = @id',
);
/**
 * Used by erasure: drop every notification addressed to the contributor (their
 * chat) or about them (subject_id) — regardless of delivery status, since sent
 * rows retain the rendered text (pitches, names, work) and their chat id.
 */
export function deleteForContributor(telegramId: number): number {
  return deleteForContributorStmt.run({ chat: String(telegramId), id: telegramId }).changes;
}
