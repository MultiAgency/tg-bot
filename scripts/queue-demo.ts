/**
 * Notification-queue demo: exercises the durable queue + background worker
 * directly with a fake Telegram sender — delivery, global dedup, retry/backoff to
 * permanent failure, 429 flood-control, restart-without-duplicates, and media.
 * Run: npm run queue-demo (throwaway database).
 */
import assert from 'node:assert';
import { enqueue, enqueueMany, statusCounts, findByDedup, pruneFinished } from '../src/core/models/notification.js';
import { drainNotifications, type Sender } from '../src/bot/worker.js';

interface Call {
  method: 'sendMessage' | 'sendPhoto' | 'sendDocument' | 'sendVideo';
  chatId: number | string;
  arg: string;
  extra?: Record<string, unknown>;
}

/** A fake Sender that records calls and can fail (permanently) or flood (transient 429). */
function makeSender(opts: { failChats?: number[]; floodTimes?: Record<number, number> } = {}): Sender & { calls: Call[] } {
  const failChats = new Set(opts.failChats ?? []);
  const flood = new Map<number, number>(Object.entries(opts.floodTimes ?? {}).map(([k, v]) => [Number(k), v]));
  const calls: Call[] = [];
  const maybeThrow = (chatId: number | string): void => {
    const n = typeof chatId === 'number' ? chatId : Number(chatId);
    const left = flood.get(n) ?? 0;
    if (left > 0) {
      flood.set(n, left - 1);
      throw Object.assign(new Error('Too Many Requests'), { parameters: { retry_after: 0.01 } });
    }
    if (failChats.has(n)) throw new Error(`chat ${n} unreachable`);
  };
  return {
    calls,
    async sendMessage(chatId, text, extra) {
      calls.push({ method: 'sendMessage', chatId, arg: text, extra });
      maybeThrow(chatId);
    },
    async sendPhoto(chatId, file, extra) {
      calls.push({ method: 'sendPhoto', chatId, arg: file, extra });
      maybeThrow(chatId);
    },
    async sendDocument(chatId, file, extra) {
      calls.push({ method: 'sendDocument', chatId, arg: file, extra });
      maybeThrow(chatId);
    },
    async sendVideo(chatId, file, extra) {
      calls.push({ method: 'sendVideo', chatId, arg: file, extra });
      maybeThrow(chatId);
    },
  };
}

// --- 1. Delivery: queued messages are sent, once each, and marked sent ---
enqueue({ dedupKey: 'q:1', chatId: '101', subjectId: null, text: 'one' });
enqueue({ dedupKey: 'q:2', chatId: '102', subjectId: null, text: 'two' });
enqueue({ dedupKey: 'q:3', chatId: '103', subjectId: null, text: 'three' });
const good = makeSender();
await drainNotifications(good);
assert.equal(good.calls.length, 3, 'all three delivered');
assert.equal(statusCounts().sent, 3, 'all three marked sent');
assert.equal(statusCounts().queued, 0, 'nothing left queued');

// --- 2. Restart safety: a second drain re-sends nothing (status persists) ---
await drainNotifications(good);
assert.equal(good.calls.length, 3, 'restart delivered no duplicates');

// --- 3. Global dedup: same dedup_key enqueued twice is one row ---
assert.equal(enqueue({ dedupKey: 'q:dup', chatId: '200', subjectId: null, text: 'x' }), true, 'first insert');
assert.equal(enqueue({ dedupKey: 'q:dup', chatId: '200', subjectId: null, text: 'x' }), false, 'duplicate ignored');
const dup = makeSender();
await drainNotifications(dup);
assert.equal(dup.calls.length, 1, 'deduped message sent once');

// --- 4. Retry with backoff → permanent failure after the attempt budget ---
enqueue({ dedupKey: 'q:fail', chatId: '500', subjectId: null, text: 'nope' });
const failing = makeSender({ failChats: [500] });
await drainNotifications(failing);
const failed = findByDedup('q:fail')!;
assert.equal(failed.status, 'failed', 'gives up after the retry budget');
assert.equal(failed.attempts, 6, 'exhausted all attempts');
assert.ok(failed.last_error, 'records the last error');
assert.ok(failing.calls.length >= 6, 'retried each attempt');
assert.equal(statusCounts().failed, 1, 'one failed, observable in counts');

// --- 5. 429 flood-control: waited out, then delivered — and NOT counted against the budget ---
enqueue({ dedupKey: 'q:flood', chatId: '600', subjectId: null, text: 'later' });
const flooded = makeSender({ floodTimes: { 600: 3 } }); // floods 3x, then delivers
await drainNotifications(flooded);
const recovered = findByDedup('q:flood')!;
assert.equal(recovered.status, 'sent', 'recovered after the flood waits');
assert.equal(recovered.attempts, 1, 'flood waits are not attempts — only the successful delivery counts');

// --- 5b. Floods must not erode the real-error retry budget ---
enqueue({ dedupKey: 'q:flood-then-fail', chatId: '900', subjectId: null, text: 'x' });
const floodThenFail = makeSender({ floodTimes: { 900: 4 }, failChats: [900] });
await drainNotifications(floodThenFail);
const ftf = findByDedup('q:flood-then-fail')!;
assert.equal(ftf.status, 'failed', 'still fails only after exhausting real-error attempts');
assert.equal(ftf.attempts, 6, 'the 4 floods consumed none of the 6-attempt real-error budget');

// --- 6. Media: photo/document/video go out via the right API with caption ---
enqueue({ dedupKey: 'q:photo', chatId: '700', subjectId: null, mediaKind: 'photo', mediaFileId: 'file-abc', caption: 'shot' });
enqueue({ dedupKey: 'q:doc', chatId: '701', subjectId: null, mediaKind: 'document', mediaFileId: 'file-def', caption: null });
enqueue({ dedupKey: 'q:video', chatId: '702', subjectId: null, mediaKind: 'video', mediaFileId: 'file-ghi', caption: 'clip' });
const media = makeSender();
await drainNotifications(media);
assert.ok(
  media.calls.some((c) => c.method === 'sendPhoto' && c.chatId === 700 && c.arg === 'file-abc'),
  'photo sent via sendPhoto',
);
assert.ok(
  media.calls.some((c) => c.method === 'sendDocument' && c.chatId === 701 && c.arg === 'file-def'),
  'document sent via sendDocument',
);
assert.ok(
  media.calls.some((c) => c.method === 'sendVideo' && c.chatId === 702 && c.arg === 'file-ghi'),
  'video sent via sendVideo',
);

// --- 7. Batch enqueue (the announcement fan-out) ---
enqueueMany([
  { dedupKey: 'q:fan:1', chatId: '801', subjectId: null, text: 'a' },
  { dedupKey: 'q:fan:2', chatId: '802', subjectId: null, text: 'b' },
  { dedupKey: 'q:fan:1', chatId: '801', subjectId: null, text: 'a' }, // dup within the batch
]);
const fan = makeSender();
await drainNotifications(fan);
assert.equal(fan.calls.length, 2, 'fan-out deduped within the batch');

// --- 8. Retention: finished (sent/failed) rows prune; queued rows never do ---
enqueue({ dedupKey: 'q:still-pending', chatId: '999', subjectId: null, text: 'not yet due' });
const before = statusCounts();
const pruned = pruneFinished('9999-01-01T00:00:00.000Z'); // cutoff after everything
assert.equal(pruned, before.sent + before.failed, 'every finished row pruned');
assert.equal(statusCounts().sent + statusCounts().failed, 0, 'no finished rows remain');
assert.ok(findByDedup('q:still-pending'), 'queued rows survive pruning');
await drainNotifications(makeSender());

const final = statusCounts();
console.log('notification counts:', final);
assert.equal(final.queued + final.retrying, 0, 'queue fully drained');
console.log('✅ QUEUE DEMO PASSED — delivery, dedup, retry→fail, 429, restart-safety, media, fan-out.');
