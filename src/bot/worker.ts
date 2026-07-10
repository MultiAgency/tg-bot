import { config } from '../config.js';
import { backupDb } from '../core/db.js';
import {
  claimDue,
  enqueue,
  isStillQueued,
  markSent,
  markRetry,
  markFailed,
  pruneFinished,
  type NotificationRow,
  type MediaKind,
} from '../core/models/notification.js';
import { t, contributorLocale } from './i18n.js';

/**
 * The single global notification worker. It drains the queue one message at a
 * time — which *is* the global rate limiter: one process, one loop, one paced
 * send at a time, so the whole system never exceeds MIN_INTERVAL_MS between
 * outbound messages regardless of how many broadcasts are in flight. Failed
 * sends are retried with exponential backoff and capped attempts; Telegram 429
 * flood-control is honored via its retry_after. Delivery status is persisted, so
 * a restart picks up where it left off, claiming only 'queued' rows. Delivery is
 * at-least-once: a crash in the window between a successful send and markSent
 * leaves that row 'queued', so it goes out again on restart — the benign
 * duplicate inherent to an outbox without transactional sends (marking before
 * sending would instead lose the message when the send fails).
 */

/** Minimal surface the worker needs from Telegraf's Telegram — also lets tests inject a fake. */
export interface Sender {
  sendMessage(chatId: number | string, text: string, extra?: Record<string, unknown>): Promise<unknown>;
  sendPhoto(chatId: number | string, file: string, extra?: Record<string, unknown>): Promise<unknown>;
  sendDocument(chatId: number | string, file: string, extra?: Record<string, unknown>): Promise<unknown>;
  sendVideo(chatId: number | string, file: string, extra?: Record<string, unknown>): Promise<unknown>;
}

const MIN_INTERVAL_MS = Math.ceil(1000 / config.notifyRatePerSec);
const BATCH = 100;
const IDLE_MS = 1000;
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 300_000;
// Far enough in the future that claimDue(FAR_FUTURE) returns every queued row
// regardless of backoff — used by drainNotifications() in tests/demos.
const FAR_FUTURE = '9999-12-31T23:59:59.999Z';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff for the Nth attempt (1-based): 5s, 10s, 20s, … capped at 5 min. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

/** retry_after (seconds) from a Telegram 429, in ms — or null if not a 429. */
function retryAfterMs(err: unknown): number | null {
  const e = err as { parameters?: { retry_after?: number }; response?: { parameters?: { retry_after?: number } } };
  const secs = e?.parameters?.retry_after ?? e?.response?.parameters?.retry_after;
  return typeof secs === 'number' ? secs * 1000 : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Numeric chat ids are stored as text; hand Telegram a number so @usernames stay strings. */
function toChat(chatId: string): number | string {
  return /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
}

/**
 * Photo-vs-document dispatch, shared by queue delivery below and the /review
 * inline attachment (notify.sendSubmissionAttachment) so media handling can't
 * drift between the two send paths.
 */
export async function sendMedia(
  sender: Sender,
  chat: number | string,
  media: { kind: MediaKind; fileId: string; caption?: string },
  extra?: Record<string, unknown>,
): Promise<void> {
  const opts = { caption: media.caption, ...extra };
  if (media.kind === 'photo') await sender.sendPhoto(chat, media.fileId, opts);
  else if (media.kind === 'video') await sender.sendVideo(chat, media.fileId, opts);
  else await sender.sendDocument(chat, media.fileId, opts);
}

async function deliver(sender: Sender, row: NotificationRow): Promise<void> {
  const chat = toChat(row.chat_id);
  const markup = row.reply_markup ? { reply_markup: JSON.parse(row.reply_markup) } : undefined;
  if (row.media_kind) {
    await sendMedia(sender, chat, { kind: row.media_kind, fileId: row.media_file_id!, caption: row.caption ?? undefined }, markup);
  } else {
    await sender.sendMessage(chat, row.text ?? '', markup);
  }
}

// Dispatch time of the last outbound send, kept at module scope so pacing holds
// GLOBALLY — across batches and across processDue calls, not just within one batch.
let lastSentAt = 0;

/** Wait until at least MIN_INTERVAL_MS has passed since the previous send, then claim this slot. */
async function paceSend(): Promise<void> {
  const since = Date.now() - lastSentAt;
  if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since);
  lastSentAt = Date.now();
}

/**
 * Deliver every due notification once, globally paced by MIN_INTERVAL_MS. Returns
 * how many rows were attempted (0 means the queue is idle). `now` is injectable so
 * drainNotifications can force all rows due without waiting out real backoff.
 */
async function processDue(sender: Sender, opts: { now?: string; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date().toISOString();
  const due = claimDue(now, opts.limit ?? BATCH);
  for (const row of due) {
    await paceSend();
    // Erasure (/forget) may have deleted this claimed row while earlier rows
    // in the batch were being paced and sent — skip anything no longer queued
    // rather than deliver data the admin was just told was purged.
    if (!isStillQueued(row.id)) continue;
    try {
      await deliver(sender, row);
      markSent(row.id);
    } catch (err) {
      const wait = retryAfterMs(err);
      const nextAttempt = row.attempts + 1;
      if (wait !== null) {
        // Flood control: a 429 is a bot-wide "slow down", not a delivery failure.
        // Pause the whole worker for the requested time and leave the row queued
        // (still due) — it retries next pass without consuming the retry budget.
        await sleep(wait);
        lastSentAt = Date.now();
      } else if (nextAttempt >= MAX_ATTEMPTS) {
        markFailed(row.id, errMsg(err));
        console.error(`[notify-worker] gave up on notification ${row.id} after ${nextAttempt} attempts: ${errMsg(err)}`);
      } else {
        markRetry(row.id, errMsg(err), isoIn(backoffMs(nextAttempt)));
      }
    }
  }
  return due.length;
}

/** Drain the whole queue now (for tests/demos). Bypasses backoff via FAR_FUTURE. */
export async function drainNotifications(sender: Sender, maxPasses = 1000): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const attempted = await processDue(sender, { now: FAR_FUTURE });
    if (attempted === 0) break;
    total += attempted;
  }
  return total;
}

// Retention for delivered/failed rows: enough to debug delivery issues, not an
// unbounded PII archive. Runs at startup and then daily from the worker tick.
const RETENTION_DAYS = 30;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
let lastPrunedAt = 0;

function maybePrune(): void {
  if (Date.now() - lastPrunedAt < PRUNE_EVERY_MS) return;
  lastPrunedAt = Date.now();
  const pruned = pruneFinished(isoIn(-RETENTION_DAYS * 24 * 60 * 60 * 1000));
  if (pruned > 0) console.log(`[notify-worker] pruned ${pruned} finished notification(s) older than ${RETENTION_DAYS}d`);
}

// Same daily cadence as pruning: an on-volume snapshot (weekday rotation, see
// backupDb). A failure is logged but never stops delivery — stale backups are
// an ops alert, not an outage.
let lastBackupAt = 0;

async function maybeBackup(): Promise<void> {
  if (Date.now() - lastBackupAt < PRUNE_EVERY_MS) return;
  lastBackupAt = Date.now();
  try {
    const file = await backupDb();
    console.log(`[notify-worker] database backed up to ${file}`);
  } catch (err) {
    console.error('[notify-worker] database backup FAILED:', errMsg(err));
    // Railway has no log-content alerting, so the alert IS a notification: DM
    // every admin through the queue. Sound even though the queue lives in the
    // same database — a failed *backup* (target file, disk space) doesn't mean
    // the live DB stopped working. Deduped per admin per day, restart-safe.
    const day = new Date().toISOString().slice(0, 10);
    for (const adminId of config.adminIds) {
      enqueue({
        dedupKey: `backup-failed:${day}:${adminId}`,
        chatId: String(adminId),
        subjectId: null, // ops content, names no one
        text: t(contributorLocale(adminId), 'notify.backupFailed', { error: errMsg(err).slice(0, 300) }),
      });
    }
  }
}

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Start the background worker (idempotent). Ticks until stopWorker() is called. */
export function startWorker(sender: Sender): void {
  if (running) return;
  running = true;
  const tick = async (): Promise<void> => {
    if (!running) return;
    let attempted = 0;
    try {
      maybePrune();
      await maybeBackup();
      attempted = await processDue(sender);
    } catch (err) {
      console.error('[notify-worker] tick failed:', errMsg(err));
    }
    if (!running) return;
    timer = setTimeout(tick, attempted > 0 ? 0 : IDLE_MS);
  };
  void tick();
}

export function stopWorker(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
