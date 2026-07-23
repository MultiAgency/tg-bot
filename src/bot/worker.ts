import { config } from '../config.js';
import { tryAcquireSessionLock, type SessionLock } from '../core/db.js';
import {
  claimDue,
  isStillQueued,
  markSent,
  markRetry,
  markFailed,
  redirectQueuedChat,
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

/** Telegram API error payload — Telegraf raises it either bare or nested under
 *  `.response`. tgError() flattens the two shapes so extractors read one. */
type TgApiError = {
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

function tgError(err: unknown): TgApiError {
  const e = err as (TgApiError & { response?: TgApiError }) | null | undefined;
  return { ...e?.response, ...e };
}

/** retry_after (seconds) from a Telegram 429, in ms — or null if not a 429. */
function retryAfterMs(err: unknown): number | null {
  const secs = tgError(err).parameters?.retry_after;
  return typeof secs === 'number' ? secs * 1000 : null;
}

/** The successor chat id from a 400 "group chat was upgraded to a supergroup
 *  chat" — Telegram names it in the error parameters — or null otherwise. */
function migratedChatId(err: unknown): number | null {
  const id = tgError(err).parameters?.migrate_to_chat_id;
  return typeof id === 'number' ? id : null;
}

/**
 * Errors no retry can fix: the recipient blocked the bot / was kicked (403), the
 * chat no longer exists, or the account was deleted. Burning the six-attempt
 * backoff on these wastes ~5 paced send slots per blocked recipient — at
 * fan-out scale that delays live notifications behind dead ones — and the row
 * still lands in /admin's failed count, just ten minutes late.
 */
function isPermanentSendError(err: unknown): boolean {
  const { error_code: code, description } = tgError(err);
  if (code === 403) return true;
  const desc = (description ?? '').toLowerCase();
  return code === 400 && (desc.includes('chat not found') || desc.includes('user is deactivated'));
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

/** Telegram's permanent entity-parse failure — retrying the identical HTML can never succeed. */
function isEntityParseError(err: unknown): boolean {
  const desc = tgError(err).description ?? (err instanceof Error ? err.message : '');
  return desc.includes("can't parse entities");
}

async function deliver(sender: Sender, row: NotificationRow): Promise<void> {
  const chat = toChat(row.chat_id);
  const markup = row.reply_markup ? { reply_markup: JSON.parse(row.reply_markup) } : {};
  const send = (extra: Record<string, unknown>): Promise<unknown> =>
    row.media_kind
      ? sendMedia(sender, chat, { kind: row.media_kind, fileId: row.media_file_id!, caption: row.caption ?? undefined }, extra)
      : sender.sendMessage(chat, row.text ?? '', extra);
  // Enqueued text is HTML like everything the bot sends (cards, escaped catalog
  // strings) — the worker is a send boundary, so parse_mode rides along here the
  // way the ctx.reply middleware injects it for synchronous replies.
  try {
    await send({ parse_mode: 'HTML' as const, ...markup });
  } catch (err) {
    if (!isEntityParseError(err)) throw err;
    // A parse failure is permanent: the row would burn its whole retry budget on
    // the same 400 and be marked failed — the contributor silently loses the
    // DM. Rows enqueued by a build predating the HTML formatter (still queued
    // across the deploy) hit exactly this; so would any future escaping bug.
    // For a notification, delivery beats formatting: resend as plain text.
    console.warn(`[notify-worker] notification ${row.id} failed HTML parse — resending as plain text`);
    await send(markup);
  }
}

// ---- Give-up alerting (minimal ops signal) ----
// A retry-exhausted TRANSIENT failure is systemic (network, a formatting bug,
// Telegram trouble) and previously surfaced only in logs and the pull-only
// /admin count. The alerter (wired from src/index.ts — a setter, so this module
// never imports notify.ts, which imports it) fans one summary to global admins,
// throttled to one alert per window so a mass failure can't flood them. Routine
// permanent errors (403 blocked, dead chat) and alert rows themselves
// ('ops-alert:' dedup prefix) never alert — the latter is the recursion guard.
export type GiveUpAlerter = (notificationId: number, attempts: number, error: string, alsoCount: number) => Promise<void>;
let giveUpAlerter: GiveUpAlerter | null = null;
export function setGiveUpAlerter(fn: GiveUpAlerter): void {
  giveUpAlerter = fn;
}
const OPS_ALERT_WINDOW_MS = 10 * 60_000;
let lastOpsAlertAt = 0;
let gaveUpSinceAlert = 0;

async function maybeAlertGiveUp(row: NotificationRow, attempts: number, error: string): Promise<void> {
  if (!giveUpAlerter || (row.dedup_key ?? '').startsWith('ops-alert:')) return;
  gaveUpSinceAlert += 1;
  if (Date.now() - lastOpsAlertAt < OPS_ALERT_WINDOW_MS) return;
  lastOpsAlertAt = Date.now();
  const alsoCount = gaveUpSinceAlert - 1;
  gaveUpSinceAlert = 0;
  // Enqueue-only (no send) — but still guarded: an alerting failure must never
  // take down the delivery loop it reports on.
  await giveUpAlerter(row.id, attempts, error, alsoCount).catch((err) =>
    console.error('[notify-worker] give-up alert failed:', errMsg(err)),
  );
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
  // claimDue's per-chat FIFO predicate claims at most ONE row per chat per pass:
  // a chat's earlier still-queued row (even one backing off after a failure)
  // structurally blocks its later siblings — including rows enqueued after a
  // deferral — so a later message can never overtake an earlier one to the same
  // recipient (e.g. an "unassigned" DM before its "assigned"). No per-pass
  // bookkeeping is needed to hold that invariant.
  const due = await claimDue(now, opts.limit ?? BATCH);
  // Chats that received a migrate-redirect this pass: a redirected row now
  // belongs to its NEW chat, where it may be older than a row already claimed
  // in this batch under that id — deliver that one and the order inverts. Skip
  // the new chat's rows for the rest of the pass; the next claim re-orders.
  const redirectedTo = new Set<string>();
  for (const row of due) {
    // Shutdown mid-batch: stop between sends. Unsent claimed rows stay
    // 'queued' and the next boot re-claims them — no send is interrupted and
    // nothing is lost, but the process doesn't hold shutdown for a full batch.
    if (opts.stopped?.()) break;
    if (redirectedTo.has(row.chat_id)) continue;
    await paceSend();
    // Erasure (/forget) may have deleted this claimed row since the batch was
    // claimed — re-check AFTER the pacing sleep, immediately before the send,
    // so a /forget that commits mid-pace can't have its row delivered anyway.
    // A pacing interval spent on the rare purged row is the cheap side of that
    // trade; the wide side is delivering data the admin was just told is gone.
    if (!(await isStillQueued(row.id))) continue;
    try {
      await deliver(sender, row);
      await markSent(row.id);
    } catch (err) {
      const wait = retryAfterMs(err);
      const migratedTo = migratedChatId(err);
      const nextAttempt = row.attempts + 1;
      if (wait !== null) {
        // Flood control: a 429 is "slow down", not a delivery failure. Sleep out
        // the window and leave this row queued (no retry budget consumed) — as
        // its chat's head it keeps blocking its siblings until it goes out.
        // Interruptible so shutdown doesn't wait out a multi-second retry_after.
        await interruptibleSleep(wait, opts.signal);
        lastSentAt = Date.now();
      } else if (migratedTo !== null) {
        // The group upgraded to a supergroup: the old chat id is dead and every
        // queued row addressed to it would 400 forever. Telegram names the
        // successor in the error — redirect the whole queued backlog for this
        // chat (no budget consumed; the send never had a chance) and let the
        // next pass deliver to the new id. The bot-side migrate handler usually
        // rewrites these rows first; this covers rows enqueued in the gap.
        console.warn(`[notify-worker] chat ${row.chat_id} migrated to ${migratedTo} — redirecting its queued rows`);
        await redirectQueuedChat(row.chat_id, String(migratedTo));
        redirectedTo.add(String(migratedTo));
      } else if (isPermanentSendError(err) || nextAttempt >= MAX_ATTEMPTS) {
        await markFailed(row.id, errMsg(err));
        console.error(`[notify-worker] gave up on notification ${row.id} after ${nextAttempt} attempt(s): ${errMsg(err)}`);
        // Alert admins on retry-exhausted transient failures only — a permanent
        // 403/dead-chat is a routine recipient state, not an ops event.
        if (!isPermanentSendError(err)) await maybeAlertGiveUp(row, nextAttempt, errMsg(err));
      } else {
        // Leave it queued for a backed-off retry; as the head of its chat it
        // structurally defers its siblings until it is sent or gives up.
        await markRetry(row.id, errMsg(err), isoIn(backoffMs(nextAttempt)));
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

// Pre-stale assignment nudges ride the leader tick like the prune — the sweep
// itself is a notification PRODUCER, injected by index.ts (setStaleNudger, the
// same seam as setGiveUpAlerter) so the worker stays free of producer imports.
// A failure is logged and retried next window; the producer's dedup keys make
// any overlap or rollover re-run idempotent.
const NUDGE_EVERY_MS = 6 * 60 * 60 * 1000;
let lastNudgedAt = 0;
let staleNudger: ((stopped: () => boolean) => Promise<void>) | null = null;
export function setStaleNudger(fn: () => Promise<void>): void {
  staleNudger = fn;
}
async function maybeNudgeStale(): Promise<void> {
  if (!staleNudger || Date.now() - lastNudgedAt < NUDGE_EVERY_MS) return;
  lastNudgedAt = Date.now();
  try {
    await staleNudger(() => !running);
  } catch (err) {
    console.error('[notify-worker] stale-nudge sweep failed:', err instanceof Error ? err.message : err);
  }
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

// ---- Delivery leadership (single writer across processes) ----
// claimDue is a plain SELECT — rows stay 'queued' until markSent — so two live
// workers would both claim and send the same rows. That is exactly the deploy
// rollover: the launch path plans for a ~50s window where the OLD container
// still polls (its 409-retry raison d'être) while the new one has already
// booted, and both would run this loop against one queue → every queued
// notification delivered twice. A Postgres session advisory lock is the leader
// election: only the holder delivers; a crashed/killed holder frees the lock
// with the connection, and the new container takes over on its next attempt.
// The migration lock is 8_274_301; this key is its sibling.
const DELIVERY_LEADER_LOCK_KEY = 8_274_302;
const LEADER_RETRY_MS = 5_000;
let leaderLock: SessionLock | null = null;

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
      // Leadership first: the heartbeat doubles as the lock connection's
      // keepalive (an idle session a platform reaps would silently drop the
      // lock), and a non-leader does nothing but retry — no prune, no claim.
      if (leaderLock && !(await leaderLock.heartbeat())) {
        console.warn('[notify-worker] delivery leadership lost (lock connection died) — re-acquiring');
        leaderLock = null;
      }
      if (!leaderLock) {
        leaderLock = await tryAcquireSessionLock(DELIVERY_LEADER_LOCK_KEY);
        if (leaderLock) console.log('[notify-worker] delivery leadership acquired');
      }
      if (leaderLock) {
        await maybePrune();
        await maybeNudgeStale();
        attempted = await processDue(sender, { stopped: () => !running, signal });
      }
    } catch (err) {
      console.error('[notify-worker] tick failed:', errMsg(err));
    }
    if (!running) return;
    timer = setTimeout(() => {
      inFlight = tick();
    }, attempted > 0 ? 0 : leaderLock ? IDLE_MS : LEADER_RETRY_MS);
  };
  inFlight = tick();
}

/** Stop ticking, wait out the in-flight tick, and hand off delivery leadership —
 *  after this the pool is safe to close and a successor can take the lock. */
export async function stopWorker(): Promise<void> {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  stopController?.abort(); // wake an in-flight flood-control sleep
  await inFlight;
  await leaderLock?.release().catch(() => undefined);
  leaderLock = null;
}
