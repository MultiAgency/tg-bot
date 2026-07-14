/**
 * Ephemeral per-room context for signal detection: the last few minutes of a
 * room's chatter, held in memory only and never persisted. It gives the signal
 * model the surrounding conversation that a single message lacks, so a draft can
 * pick up a deadline or scope mentioned a few lines earlier.
 *
 * Privacy: this is the one place recent message text lingers at all, and it is
 * deliberately bounded and RAM-only — evicted by age and count, dropped entirely
 * on restart, never written to disk. Nothing here is an author id; entries are
 * bare text. See /privacy and SCOPE.md.
 */

interface Entry {
  text: string;
  ts: number;
}

// Small on purpose: recent context, not a transcript. Older chatter isn't
// "current" and would only dilute the signal (and cost tokens).
const MAX_PER_ROOM = 15;
const MAX_AGE_MS = 30 * 60_000; // 30 minutes
// A single pasted wall of text shouldn't dominate the window or the token bill.
const MAX_TEXT_LEN = 600;
// Backstop so a burst of one-off groups can't grow the map without bound; stale
// rooms are swept well before this in practice.
const MAX_ROOMS = 500;

const windows = new Map<number, Entry[]>();

/** Drop entries older than the age cap, then keep only the newest MAX_PER_ROOM. */
function prune(entries: Entry[], now: number): Entry[] {
  const cutoff = now - MAX_AGE_MS;
  const fresh = entries.filter((e) => e.ts >= cutoff);
  return fresh.length > MAX_PER_ROOM ? fresh.slice(-MAX_PER_ROOM) : fresh;
}

/** Evict rooms whose most recent message has aged out entirely. */
function sweepStale(now: number): void {
  const cutoff = now - MAX_AGE_MS;
  for (const [id, entries] of windows) {
    const last = entries[entries.length - 1];
    if (!last || last.ts < cutoff) windows.delete(id);
  }
}

/**
 * Append a message to its room's window. Call this for human, non-command group
 * text regardless of length — short messages are still context, even when they
 * are too thin to trigger a paid evaluation themselves.
 */
export function recordMessage(chatId: number, text: string): void {
  const now = Date.now();
  const entries = prune(windows.get(chatId) ?? [], now);
  entries.push({ text: text.slice(0, MAX_TEXT_LEN), ts: now });
  // Delete-then-set keeps Map iteration order = least-recently-active first,
  // making the eviction below LRU.
  windows.delete(chatId);
  windows.set(chatId, entries);
  if (windows.size > MAX_ROOMS) {
    sweepStale(now);
    // Still over (every room active inside the age window): evict the
    // least-recently-active so MAX_ROOMS is a real bound, not advisory.
    for (const oldest of windows.keys()) {
      if (windows.size <= MAX_ROOMS) break;
      windows.delete(oldest);
    }
  }
}

/**
 * The room's current context, oldest first. Call this BEFORE recordMessage for
 * the triggering message, so the returned window holds only the PRIOR chatter —
 * the context around the message, not the message itself.
 */
export function roomContext(chatId: number): string[] {
  const now = Date.now();
  const entries = prune(windows.get(chatId) ?? [], now);
  if (entries.length) windows.set(chatId, entries);
  else windows.delete(chatId);
  return entries.map((e) => e.text);
}
