/**
 * Registry for fire-and-forget background work (signal evaluation, the detached
 * AI review note). These run outside any request's await chain — deliberately,
 * so a user's update queue never waits on the model — but they open their own
 * DB transactions, so shutdown must let them finish before closePool(): a
 * detached transaction that calls pool.connect() after the pool has ended throws
 * and silently loses its work (a dropped signal draft left stuck 'evaluating').
 *
 * Each work unit receives a shutdown AbortSignal, which its AI call hands to the
 * model client. That closes the gap between the model's 30s request timeout and
 * a short drain bound: instead of waiting out a fixed window and then severing an
 * in-flight request with closePool(), beginShutdown() aborts it — the request
 * rejects at once and the evaluation records its terminal DB write on the
 * still-open pool in milliseconds. drainDetached's timeout is only a backstop for
 * work that ignores the signal. The same signal is exported for request-path AI
 * calls (the /newtask wizard's /ai drafts), so those unwind on shutdown too.
 */

const inflight = new Set<Promise<unknown>>();
const shutdown = new AbortController();

/**
 * The process-wide shutdown signal, aborted by beginShutdown(). Detached work
 * gets it automatically via runDetached; a request-path AI call (the wizard) can
 * pass it to complete() so it aborts on shutdown instead of pinning the update
 * handler — and thus `await launched` — for the model's full timeout.
 */
export const shutdownSignal = shutdown.signal;

/**
 * Signal a graceful stop: abort any in-flight cancelable work (model requests).
 * Idempotent — safe to call from both the shutdown sequence and drainDetached.
 */
export function beginShutdown(): void {
  shutdown.abort();
}

/**
 * Run `work` detached: its promise is tracked (and errors logged with `label`)
 * so drainDetached can await it during shutdown. `work` receives the shutdown
 * AbortSignal to pass to any cancelable call it makes (its model request). The
 * returned promise never rejects — callers fire-and-forget it.
 */
export function runDetached(label: string, work: (signal: AbortSignal) => Promise<unknown>): void {
  const p = work(shutdown.signal)
    .catch((err) => console.error(`[${label}] failed:`, err instanceof Error ? err.message : err))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

/**
 * Await in-flight detached work settling, aborting it first (via beginShutdown)
 * so a request blocked on the model unwinds immediately and commits its terminal
 * DB write on the still-open pool — rather than holding shutdown for the model's
 * full timeout. `timeoutMs` is a backstop for work that ignores the signal; the
 * timer is cleared either way, so a drain that finishes early can't keep the
 * event loop alive for the remainder of it.
 */
export async function drainDetached(timeoutMs = 5000): Promise<void> {
  beginShutdown(); // idempotent — the shutdown sequence may have called it already
  if (inflight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled([...inflight]), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
