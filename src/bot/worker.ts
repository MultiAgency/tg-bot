import { config } from '../config.js';
import {
  claimDue,
  isStillQueued,
  markSent,
  markRetry,
  markFailed,
  deferChatRowsAfter,
  pruneFinished,
  type NotificationRow,
  type MediaKind,
} from '../core/models/notification.js';

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
  sendVideoNote(chatId: number | string, file: string, extra?: Record<string, unknown>): Promise<unknown>;
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

/**
 * sleep(ms) that also resolves the moment `signal` aborts — so a long flood-control
 * wait (Telegram retry_after can be tens of seconds) doesn't pin shutdown past the
 * platform's SIGTERM→SIGKILL grace window. Returns early on abort; the caller
 * re-checks `stopped()` and breaks without consuming the row's retry budget.
 */
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

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
  if (err instanceof Error) return err.message || err.name || String(err);
  return String(err);
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
  // sendVideoNote takes no caption (the Bot API has none for video notes) —
  // only the markup/extra passes through.
  if (media.kind === 'video_note') return void (await sender.sendVideoNote(chat, media.fileId, extra));
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
async function processDue(
  sender: Sender,
  opts: { now?: string; limit?: number; stopped?: () => boolean; signal?: AbortSignal } = {},
): Promise<number> {
  const now = opts.now ?? new Date().toISOString();
  const due = await claimDue(now, opts.limit ?? BATCH);
  // Chats that returned a 429 this pass. We skip their remaining rows to keep each
  // recipient's messages in order (a later row must not overtake the queued one
  // that flooded), while still serving OTHER chats — a per-chat pause, not a
  // whole-batch stall, so one flooded chat can't starve the rest of the queue.
  const floodedChats = new Set<string>();
  for (const row of due) {
    // Shutdown mid-batch: stop between sends. Unsent claimed rows stay
    // 'queued' and the next boot re-claims them — no send is interrupted and
    // nothing is lost, but the process doesn't hold shutdown for a full batch.
    if (opts.stopped?.()) break;
    // This chat already deferred a row this pass (429 or a transient retry):
    // leave this one queued in order rather than delivering it ahead of the
    // earlier row that failed. A later message must never overtake an earlier
    // one to the same recipient (e.g. an "unassigned" DM before its "assigned").
    if (floodedChats.has(row.chat_id)) continue;
    // Erasure (/forget) may have deleted this claimed row since the batch was
    // claimed — skip anything no longer queued BEFORE spending a pacing interval
    // on it, rather than deliver data the admin was just told was purged.
    if (!(await isStillQueued(row.id))) continue;
    await paceSend();
    try {
      await deliver(sender, row);
      await markSent(row.id);
    } catch (err) {
      const wait = retryAfterMs(err);
      const nextAttempt = row.attempts + 1;
      if (wait !== null) {
        // Flood control: a 429 is "slow down", not a delivery failure. Sleep out
        // the window, leave this row queued (no retry budget consumed), and skip
        // the rest of THIS chat's rows this pass — but keep serving other chats.
        // Interruptible so shutdown doesn't wait out a multi-second retry_after.
        await interruptibleSleep(wait, opts.signal);
        lastSentAt = Date.now();
        floodedChats.add(row.chat_id);
      } else if (nextAttempt >= MAX_ATTEMPTS) {
        await markFailed(row.id, errMsg(err));
        console.error(`[notify-worker] gave up on notification ${row.id} after ${nextAttempt} attempts: ${errMsg(err)}`);
      } else {
        const retryAt = isoIn(backoffMs(nextAttempt));
        await markRetry(row.id, errMsg(err), retryAt);
        // Push this chat's later queued rows out to at least this row's new attempt
        // time, so a subsequent pass can't deliver a later message before the one we
        // just deferred (claimDue would otherwise skip the future retry row and pick
        // the still-due later one). Then skip the rest of this chat this pass too.
        await deferChatRowsAfter(row.chat_id, row.id, retryAt);
        floodedChats.add(row.chat_id);
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
// Exported so /privacy states this number instead of hardcoding its own copy.
export const RETENTION_DAYS = 30;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
let lastPrunedAt = 0;

async function maybePrune(): Promise<void> {
  if (Date.now() - lastPrunedAt < PRUNE_EVERY_MS) return;
  lastPrunedAt = Date.now();
  const pruned = await pruneFinished(isoIn(-RETENTION_DAYS * 24 * 60 * 60 * 1000));
  if (pruned > 0) console.log(`[notify-worker] pruned ${pruned} finished notification(s) older than ${RETENTION_DAYS}d`);
}

// Database backups are the platform's responsibility (Railway managed backups /
// PITR) — the app no longer snapshots the database itself.

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
// The in-flight tick, so stopWorker can await it: clearing the timer alone
// would leave a running processDue issuing queries while shutdown closes the
// pool under it — the mid-batch send would fail markSent and be re-delivered
// on the next boot.
let inFlight: Promise<void> | null = null;
// Aborted by stopWorker to cut short an in-flight flood-control sleep, so
// `await inFlight` returns promptly instead of holding shutdown for a full
// Telegram retry_after.
let stopController: AbortController | null = null;

/** Start the background worker (idempotent). Ticks until stopWorker() is called. */
export function startWorker(sender: Sender): void {
  if (running) return;
  running = true;
  stopController = new AbortController();
  const signal = stopController.signal;
  const tick = async (): Promise<void> => {
    if (!running) return;
    let attempted = 0;
    try {
      await maybePrune();
      attempted = await processDue(sender, { stopped: () => !running, signal });
    } catch (err) {
      console.error('[notify-worker] tick failed:', errMsg(err));
    }
    if (!running) return;
    timer = setTimeout(() => {
      inFlight = tick();
    }, attempted > 0 ? 0 : IDLE_MS);
  };
  inFlight = tick();
}

/** Stop ticking and wait out the in-flight tick — after this the pool is safe to close. */
export async function stopWorker(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  stopController?.abort(); // wake an in-flight flood-control sleep
  await inFlight;
}
