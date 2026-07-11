/**
 * Notification-queue demo: exercises the durable queue + background worker
 * directly with a fake Telegram sender — delivery, global dedup, retry/backoff to
 * permanent failure, 429 flood-control, restart-without-duplicates, and media.
 * Run: npm run queue-demo (throwaway database).
 */
import assert from 'node:assert';
import { enqueue, enqueueMany, statusCounts, findByDedup, pruneFinished } from '../src/core/models/notification.js';
import { drainNotifications, startWorker, stopWorker, type Sender } from '../src/bot/worker.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';

interface Call {
  method: 'sendMessage' | 'sendPhoto' | 'sendDocument' | 'sendVideo' | 'sendVideoNote';
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
    async sendVideoNote(chatId, file, extra) {
      calls.push({ method: 'sendVideoNote', chatId, arg: file, extra });
      maybeThrow(chatId);
    },
  };
}

async function main(): Promise<void> {
  await resetDb();

  // --- 1. Delivery: queued messages are sent, once each, and marked sent ---
  await enqueue({ dedupKey: 'q:1', chatId: '101', subjectId: null, text: 'one' });
  await enqueue({ dedupKey: 'q:2', chatId: '102', subjectId: null, text: 'two' });
  await enqueue({ dedupKey: 'q:3', chatId: '103', subjectId: null, text: 'three' });
  const good = makeSender();
  await drainNotifications(good);
  assert.equal(good.calls.length, 3, 'all three delivered');
  assert.equal((await statusCounts()).sent, 3, 'all three marked sent');
  assert.equal((await statusCounts()).queued, 0, 'nothing left queued');

  // --- 2. Restart safety: a second drain re-sends nothing (status persists) ---
  await drainNotifications(good);
  assert.equal(good.calls.length, 3, 'restart delivered no duplicates');

  // --- 3. Global dedup: same dedup_key enqueued twice is one row ---
  assert.equal(await enqueue({ dedupKey: 'q:dup', chatId: '200', subjectId: null, text: 'x' }), true, 'first insert');
  assert.equal(await enqueue({ dedupKey: 'q:dup', chatId: '200', subjectId: null, text: 'x' }), false, 'duplicate ignored');
  const dup = makeSender();
  await drainNotifications(dup);
  assert.equal(dup.calls.length, 1, 'deduped message sent once');

  // --- 4. Retry with backoff → permanent failure after the attempt budget ---
  await enqueue({ dedupKey: 'q:fail', chatId: '500', subjectId: null, text: 'nope' });
  const failing = makeSender({ failChats: [500] });
  await drainNotifications(failing);
  const failed = (await findByDedup('q:fail'))!;
  assert.equal(failed.status, 'failed', 'gives up after the retry budget');
  assert.equal(failed.attempts, 6, 'exhausted all attempts');
  assert.ok(failed.last_error, 'records the last error');
  assert.ok(failing.calls.length >= 6, 'retried each attempt');
  assert.equal((await statusCounts()).failed, 1, 'one failed, observable in counts');

  // --- 5. 429 flood-control: waited out, then delivered — and NOT counted against the budget ---
  await enqueue({ dedupKey: 'q:flood', chatId: '600', subjectId: null, text: 'later' });
  const flooded = makeSender({ floodTimes: { 600: 3 } }); // floods 3x, then delivers
  await drainNotifications(flooded);
  const recovered = (await findByDedup('q:flood'))!;
  assert.equal(recovered.status, 'sent', 'recovered after the flood waits');
  assert.equal(recovered.attempts, 1, 'flood waits are not attempts — only the successful delivery counts');

  // --- 5b. Floods must not erode the real-error retry budget ---
  await enqueue({ dedupKey: 'q:flood-then-fail', chatId: '900', subjectId: null, text: 'x' });
  const floodThenFail = makeSender({ floodTimes: { 900: 4 }, failChats: [900] });
  await drainNotifications(floodThenFail);
  const ftf = (await findByDedup('q:flood-then-fail'))!;
  assert.equal(ftf.status, 'failed', 'still fails only after exhausting real-error attempts');
  assert.equal(ftf.attempts, 6, 'the 4 floods consumed none of the 6-attempt real-error budget');

  // --- 5c. A flooding chat must not starve OTHER chats in the same batch ---
  // The flooder is enqueued first (lower id → claimed first each pass). A 429
  // pauses only that chat, so the later bystander is delivered during the flood,
  // not held behind it (the whole-batch `break` this replaced would starve it).
  await enqueue({ dedupKey: 'q:flooder', chatId: '111', subjectId: null, text: 'busy' });
  await enqueue({ dedupKey: 'q:bystander', chatId: '222', subjectId: null, text: 'let me through' });
  const mixed = makeSender({ floodTimes: { 111: 3 } });
  await drainNotifications(mixed);
  assert.equal((await findByDedup('q:bystander'))!.status, 'sent', 'bystander delivered');
  assert.equal((await findByDedup('q:flooder'))!.status, 'sent', 'flooder delivered once its flood cleared');
  const bystanderIdx = mixed.calls.findIndex((c) => c.chatId === 222);
  const flooderSentIdx = mixed.calls.map((c) => c.chatId).lastIndexOf(111);
  assert.ok(bystanderIdx >= 0 && bystanderIdx < flooderSentIdx, 'bystander was served during the flood, not after it cleared');

  // --- 6. Media: photo/document/video go out via the right API with caption ---
  await enqueue({ dedupKey: 'q:photo', chatId: '700', subjectId: null, mediaKind: 'photo', mediaFileId: 'file-abc', caption: 'shot' });
  await enqueue({ dedupKey: 'q:doc', chatId: '701', subjectId: null, mediaKind: 'document', mediaFileId: 'file-def', caption: null });
  await enqueue({ dedupKey: 'q:video', chatId: '702', subjectId: null, mediaKind: 'video', mediaFileId: 'file-ghi', caption: 'clip' });
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
  await enqueueMany([
    { dedupKey: 'q:fan:1', chatId: '801', subjectId: null, text: 'a' },
    { dedupKey: 'q:fan:2', chatId: '802', subjectId: null, text: 'b' },
    { dedupKey: 'q:fan:1', chatId: '801', subjectId: null, text: 'a' }, // dup within the batch
  ]);
  const fan = makeSender();
  await drainNotifications(fan);
  assert.equal(fan.calls.length, 2, 'fan-out deduped within the batch');

  // --- 8. Retention: finished (sent/failed) rows prune; queued rows never do ---
  await enqueue({ dedupKey: 'q:still-pending', chatId: '999', subjectId: null, text: 'not yet due' });
  const before = await statusCounts();
  const pruned = await pruneFinished('9999-01-01T00:00:00.000Z'); // cutoff after everything
  assert.equal(pruned, before.sent + before.failed, 'every finished row pruned');
  const after = await statusCounts();
  assert.equal(after.sent + after.failed, 0, 'no finished rows remain');
  assert.ok(await findByDedup('q:still-pending'), 'queued rows survive pruning');
  await drainNotifications(makeSender());

  // --- 9. Shutdown: stopWorker() waits out the in-flight tick, then stops ---
  // The caller closes the pool right after stopWorker resolves, so an in-flight
  // send must finish AND be marked sent first (a markSent after pool.end()
  // would throw and strand the row for duplicate delivery on the next boot) —
  // while the rest of the claimed batch stops unsent and stays queued.
  await enqueue({ dedupKey: 'q:shutdown-inflight', chatId: '501', subjectId: null, text: 'mid-send at shutdown' });
  await enqueue({ dedupKey: 'q:shutdown-rest', chatId: '502', subjectId: null, text: 'later in the batch' });
  let sendStarted!: () => void;
  const started = new Promise<void>((resolve) => (sendStarted = resolve));
  let sendFinished = false;
  const slow = makeSender();
  const record = slow.sendMessage.bind(slow);
  slow.sendMessage = async (chatId, text, extra) => {
    sendStarted();
    await new Promise((resolve) => setTimeout(resolve, 100)); // shutdown arrives mid-send
    await record(chatId, text, extra);
    sendFinished = true;
  };
  startWorker(slow);
  await started; // the tick has claimed the batch and is inside the first send
  await stopWorker();
  assert.ok(sendFinished, 'stopWorker resolved only after the in-flight send completed');
  assert.equal((await findByDedup('q:shutdown-inflight'))!.status, 'sent', 'the in-flight row was marked sent, not stranded');
  assert.equal((await findByDedup('q:shutdown-rest'))!.status, 'queued', 'the rest of the batch stopped unsent — re-claimed next boot');
  assert.equal(slow.calls.length, 1, 'no send after shutdown began');
  await drainNotifications(makeSender()); // deliver the leftover so the final invariant holds

  // --- 9b. Shutdown interrupts an in-flight 429 flood-control wait ---
  // A 429 with a long retry_after must NOT pin shutdown for its full duration
  // (that would overrun the platform's SIGTERM→SIGKILL grace window). stopWorker
  // aborts the flood sleep, so it resolves promptly, leaving the row queued.
  await enqueue({ dedupKey: 'q:flood-at-shutdown', chatId: '700', subjectId: null, text: 'flooded as we stop' });
  let floodStarted!: () => void;
  const floodHit = new Promise<void>((resolve) => (floodStarted = resolve));
  const flooder = makeSender();
  flooder.sendMessage = async () => {
    floodStarted();
    throw Object.assign(new Error('Too Many Requests'), { parameters: { retry_after: 3600 } }); // 1h
  };
  startWorker(flooder);
  await floodHit; // the worker is now parked in the flood-control sleep
  const stopRace = await Promise.race([
    stopWorker().then(() => 'stopped'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ]);
  assert.equal(stopRace, 'stopped', 'stopWorker returned promptly — the 1h flood sleep was interrupted');
  assert.equal((await findByDedup('q:flood-at-shutdown'))!.status, 'queued', 'the flooded row stayed queued (no budget consumed)');
  await drainNotifications(makeSender());

  const final = await statusCounts();
  console.log('notification counts:', final);
  assert.equal(final.queued + final.retrying, 0, 'queue fully drained');
  console.log('✅ QUEUE DEMO PASSED — delivery, dedup, retry→fail, 429, restart-safety, media, fan-out.');
}

runScript(main);
