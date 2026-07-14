import type { Task } from '../core/models/task.js';
import type { Application } from '../core/models/application.js';
import { isMediaSubmission, type Submission } from '../core/models/submission.js';
import type { HistoryEntry } from '../core/models/history.js';
import { TaskStatus, ApplicationStatus, SubmissionStatus } from '../core/workflow.js';
import { contributorLabel, type Contributor } from '../core/service.js';

const dash = '—';

// Status chrome is presentation, so it lives here rather than in core.
const TASK_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.Draft]: '📝 Draft',
  [TaskStatus.Open]: '📢 Open',
  [TaskStatus.Closed]: '🔒 Closed',
};
const APPLICATION_LABELS: Record<ApplicationStatus, string> = {
  [ApplicationStatus.Applied]: '🙋 Applied',
  [ApplicationStatus.Assigned]: '✅ Assigned',
  [ApplicationStatus.Completed]: '🏁 Completed',
  [ApplicationStatus.Declined]: '🚫 Declined',
  [ApplicationStatus.Withdrawn]: '↩️ Withdrawn',
  [ApplicationStatus.Rejected]: '❌ Rejected',
};
const SUBMISSION_LABELS: Record<SubmissionStatus, string> = {
  [SubmissionStatus.Submitted]: '📬 Submitted',
  [SubmissionStatus.NeedsRevision]: '🔁 Needs revision',
  [SubmissionStatus.Approved]: '✅ Approved',
  [SubmissionStatus.Rejected]: '❌ Rejected',
};

const taskStatusLabel = (s: TaskStatus): string => TASK_LABELS[s] ?? s;
const applicationStatusLabel = (s: ApplicationStatus): string => APPLICATION_LABELS[s] ?? s;
const submissionStatusLabel = (s: SubmissionStatus): string => SUBMISSION_LABELS[s] ?? s;

// ---- HTML (Telegram parse_mode:'HTML') ----
//
// Every message the bot sends goes out with parse_mode:'HTML' (see createBot and
// the notification worker). That buys bold headers, tap-to-copy <code> ids, and
// expandable blockquotes — but it means any '<', '>' or '&' in dynamic content
// (a task title, a pitch, a reviewer note) must be escaped, or Telegram either
// drops it or 400s the whole send. The discipline here:
//   - esc() escapes the three significant characters; nothing else is markup.
//   - field() escapes AND length-bounds a piece of dynamic content, entity-safe.
//   - Structural tags (b, code, blockquote) are only ever wrapped AROUND field()
//     output — never truncated — so composed messages are always valid HTML and,
//     because each field is bounded, stay under the 4096 cap by construction.

/** Escape the three characters significant to Telegram's HTML parse mode. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Slice to at most `max` UTF-16 code units without leaving a dangling high
 * surrogate at the cut — an unpaired surrogate makes Telegram reject the whole
 * message ("strings must be encoded in UTF-8").
 */
function safeSlice(text: string, max: number): string {
  let end = Math.min(max, text.length);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Trim an already-escaped fragment to at most `max` code units without splitting
 * a trailing HTML entity (`&amp;`) — cutting mid-entity would 400 the send. The
 * fragment must contain no tags (esc() output never does), so this is safe to
 * wrap in structural tags afterward.
 */
function clampEscaped(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  let cut = safeSlice(escaped, max);
  const amp = cut.lastIndexOf('&');
  if (amp > cut.lastIndexOf(';')) cut = cut.slice(0, amp); // drop a half-cut entity
  return `${cut}…`;
}

/** Escape and length-bound one piece of dynamic content for HTML composition. */
function field(text: string, max: number): string {
  return clampEscaped(esc(text), max);
}

/** Raw (un-escaped) truncation — for callers that echo user text OUTSIDE a message send. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${safeSlice(text, max)}…`;
}

const b = (s: string): string => `<b>${s}</b>`;
// A tap-to-copy numeric id. Ids are numbers, so the content needs no escaping;
// wrapping it in <code> lets a user copy the exact id the commands take.
const id = (n: number): string => `<code>${n}</code>`;
/** Long dynamic content behind a collapsed, tap-to-expand quote. */
const expandable = (s: string): string => `<blockquote expandable>${s}</blockquote>`;

/**
 * Append closers for any structural tags still open in `html` (in reverse order),
 * so a fragment cut out of valid HTML is valid on its own. Without this a cut
 * that lands inside a <code>…</code> or <b>…</b> ships an unclosed tag and
 * Telegram rejects the whole message with 400 "unclosed tag".
 */
function closeOpenTags(html: string): string {
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      if (stack[stack.length - 1] === tag) stack.pop();
    } else {
      stack.push(tag);
    }
  }
  let out = html;
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`;
  return out;
}

/**
 * Hard clamp for a fully-composed HTML message (Telegram's 4096-char limit).
 * field() budgets keep composed messages well under the cap, so this is a
 * backstop; if it ever fires it drops any half-cut trailing tag or entity the
 * slice left behind AND closes any tag the cut left open, so the result is valid
 * HTML. Slices short of the cap to leave room for the ellipsis + closing tags.
 */
export function clampMessage(text: string): string {
  if (text.length <= 4096) return text;
  let cut = safeSlice(text, 4040);
  if (cut.lastIndexOf('<') > cut.lastIndexOf('>')) cut = cut.slice(0, cut.lastIndexOf('<'));
  const amp = cut.lastIndexOf('&');
  if (amp > cut.lastIndexOf(';') && cut.length - amp <= 12) cut = cut.slice(0, amp);
  return closeOpenTags(`${cut}…`);
}

/** Surrogate- and entity-safe clamp for a media caption (Telegram's 1024-char limit). */
export function clampCaption(text: string): string {
  if (text.length <= 1024) return text;
  const cut = safeSlice(text, 1024);
  const amp = cut.lastIndexOf('&');
  return amp > cut.lastIndexOf(';') ? cut.slice(0, amp) : cut; // never split a trailing entity
}

// Pure: the caller supplies the already-fetched contributor (presentation never
// queries the DB). Output is HTML-escaped and safe to drop into a message.
// Bounded: usernames are ≤32 chars but display names can reach ~128 raw (more
// once escaped) — list rows budget on this staying small (see /active's page math).
const label = (c: Contributor): string => field(contributorLabel(c), 64);

/**
 * The display label for an actor: their contributor label when known, else the
 * stable "user N". Exported so every surface (cards, history, /roomadmins,
 * /status) renders an actor the same escaped way.
 */
export function who(actorId: number | null | undefined, c?: Contributor): string {
  if (c) return label(c);
  if (actorId) return `user ${actorId}`;
  return 'someone';
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// ---- Tasks ----

export function taskLine(task: Task): string {
  const reward = task.reward ? ` · 🎁 ${field(task.reward, 80)}` : '';
  const slots = task.max_assignees > 1 ? ` · 👥 ${task.max_assignees}` : '';
  return `#${id(task.id)} ${b(field(task.title, 120))}${reward}${slots}`;
}

/**
 * A task teaser for inline-mode sharing: the one-line summary plus the brief, in
 * an expandable quote. No slot count — an inline result is built once per query
 * (on every keystroke), so it avoids the per-task COUNT taskDetail's card shows;
 * the Apply deep link on the result leads to the live task anyway.
 */
export function taskShareText(task: Task): string {
  const body = task.description ? `\n\n${expandable(field(task.description, 600))}` : '';
  return `${taskLine(task)}${body}`;
}

export function taskDetail(task: Task, assignedCount = 0): string {
  const lines = [
    `#${id(task.id)} ${b(field(task.title, 200))}`,
    `Status: ${taskStatusLabel(task.status)}`,
    `Reward: ${task.reward ? field(task.reward, 150) : dash}`,
    `Deadline: ${task.deadline ? field(task.deadline, 150) : dash}`,
    `Required output: ${task.required_output ? field(task.required_output, 500) : dash}`,
    `Assignees: ${assignedCount}/${task.max_assignees}`,
    '',
    expandable(field(task.description || '(no description)', 1500)),
  ];
  return clampMessage(lines.join('\n'));
}

// ---- Contributors ----

const counters = (c: Contributor): string =>
  `applied ${c.applied_count} · assigned ${c.assigned_count} · completed ${c.completed_count} · rejected ${c.rejected_count}`;

export function contributorProfile(c: Contributor): string {
  return [`👤 ${b(label(c))}`, counters(c)].join('\n');
}

// Admin-card variant: includes the numeric Telegram id because it is what
// /forget takes (usernames change; the id is the stable identifier). Labelled
// "user N", never "id N" — "id N" on these cards means the APPLICATION id, and
// an admin who confuses the two would /forget the wrong person.
function contributorStats(c: Contributor): string {
  return `👤 ${b(label(c))} (user ${id(c.telegram_id)}) — ${counters(c)}`;
}

// ---- Applications ----

/** An applicant's pitch plus their track record, for the admin to choose from. */
export function applicantCard(app: Application, c: Contributor | undefined): string {
  const pitch = app.pitch ? `\n💬 ${expandable(field(app.pitch, 800))}` : '\n💬 (no pitch)';
  return clampMessage(
    `${c ? contributorStats(c) : who(app.contributor_id)} · ${applicationStatusLabel(app.status)} · id ${id(app.id)}${pitch}`,
  );
}

/** One row in a contributor's /myapps list. */
export function applicationLine(app: Application, task: Task | undefined, latest?: Submission): string {
  const title = task ? b(field(task.title, 100)) : `task #${id(app.task_id)}`;
  const work = latest ? ` · work: ${submissionStatusLabel(latest.status)} v${latest.version}` : '';
  // "id N" is the application id that /submit, /withdraw, and /unassign take.
  return `#${id(app.task_id)} ${title} — ${applicationStatusLabel(app.status)}${work} · id ${id(app.id)}`;
}

// ---- Submissions ----

// Card clip thresholds — shared with submissionTruncated so the "Full
// submission" button appears exactly when the card actually clipped. Measured on
// the RAW text (before escaping), so the "was it clipped?" test matches what the
// contributor actually typed rather than its escaped length.
const CAPTION_CLIP = 300;
const CONTENT_CLIP = 1000;

// Submission-card clip: unlike plain field(), says the full text survives — the
// reviewer retrieves it with the "Full submission" button. Escapes as it clips.
function clipStored(text: string, max: number): string {
  if (text.length <= max) return esc(text);
  return `${field(text, max)} (truncated — full content is stored)`;
}

function describeSubmission(sub: Submission): string {
  if (isMediaSubmission(sub.type)) {
    const cap = sub.caption ? ` — ${expandable(clipStored(sub.caption, CAPTION_CLIP))}` : '';
    const kind = sub.type === 'video' || sub.type === 'video_note' ? 'video' : 'file';
    return `(${kind} attachment${cap})`;
  }
  return expandable(clipStored(sub.content, CONTENT_CLIP));
}

/** True when describeSubmission had to clip this submission for the card. */
export function submissionTruncated(sub: Submission): boolean {
  if (isMediaSubmission(sub.type)) return (sub.caption ?? '').length > CAPTION_CLIP;
  return sub.content.length > CONTENT_CLIP;
}

/**
 * The complete text behind a submission — content for text/link, caption for
 * media (the raw file is re-sent separately). This is the one surface that must
 * never clip: reviewers decide on it. Inbound Telegram text is capped at 4096
 * chars (captions at 1024), so today this always fits a single message. Escaped
 * because it, too, is sent under HTML mode.
 */
export function fullSubmissionText(sub: Submission): string {
  if (isMediaSubmission(sub.type)) return esc(sub.caption ?? '(no caption)');
  return esc(sub.content);
}

/**
 * Split escaped HTML into ≤4096-char pieces (Telegram's message cap) without
 * cutting a surrogate pair or a trailing entity — each piece is valid on its own.
 * Used for the "Full submission" path, whose escaped text can exceed one message.
 */
export function chunkMessage(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 4096) {
    let head = safeSlice(rest, 4096);
    const amp = head.lastIndexOf('&');
    if (amp > head.lastIndexOf(';')) head = head.slice(0, amp); // don't split an entity across parts
    parts.push(head);
    rest = rest.slice(head.length);
  }
  parts.push(rest);
  return parts;
}

/** Full review card: the work, its version, the task, and the worker's record. */
export function submissionReviewCard(
  sub: Submission,
  app: Application,
  task: Task | undefined,
  c: Contributor | undefined,
): string {
  const lines = [
    task ? `#${id(task.id)} ${b(field(task.title, 200))}` : `task #${id(app.task_id)}`,
    `Required output: ${task?.required_output ? field(task.required_output, 400) : dash}`,
    c ? contributorStats(c) : who(app.contributor_id),
    '',
    `📎 Submission v${sub.version} (${sub.type}): ${describeSubmission(sub)}`,
  ];
  if (sub.reviewer_note) lines.push(`📝 Prior note: ${field(sub.reviewer_note, 400)}`);
  return clampMessage(lines.join('\n'));
}

// ---- Active board ----

export function activeLine(
  app: Application,
  task: Task | undefined,
  latest: Submission | undefined,
  c: Contributor | undefined,
): string {
  const title = task ? b(field(task.title, 90)) : `task #${id(app.task_id)}`;
  const state = latest ? submissionStatusLabel(latest.status) : 'not yet submitted';
  return `• #${id(app.task_id)} ${title} — ${who(app.contributor_id, c)} · ${state} · updated ${age(app.updated_at)} ago · id ${id(app.id)}`;
}

// ---- History ----

const ACTION_LABELS: Record<string, string> = {
  created: 'created',
  approved: 'approved (opened)',
  applied: 'applied 🙋',
  assigned: 'assigned ✅',
  declined: 'declined 🚫',
  rejected: 'assignment closed ❌ (work rejected)',
  completed: 'assignment completed 🏁 (work approved)',
  unassigned: 'unassigned ➖',
  withdrawn: 'withdrawn ↩️',
  submitted: 'submitted 📬',
  review_approve: 'review: approved ✅',
  review_reject: 'review: rejected ❌',
  review_revise: 'review: revision requested 🔁',
  closed: 'closed 🔒',
  reopened: 'reopened 📢',
  contributor_forgotten: 'contributor erased 🗑️',
};

/**
 * `labels` maps an actor_id to its ALREADY-ESCAPED display label (built with
 * who()); the caller resolves the task's distinct actors once (presentation
 * stays pure). A missing id renders "user N".
 */
export function historyBlock(entries: HistoryEntry[], labels: ReadonlyMap<number, string>): string {
  if (entries.length === 0) return 'No history yet.';
  return entries
    .map((e) => {
      const when = e.created_at.slice(0, 16).replace('T', ' ');
      const name = e.actor_id ? labels.get(e.actor_id) ?? `user ${e.actor_id}` : '';
      const action = ACTION_LABELS[e.action] ?? esc(e.action);
      // Render the recorded detail (unassign reason, pitch, reviewer note) —
      // it is the audit trail's substance, not just its timestamps.
      const detail = e.detail ? ` · ${field(e.detail, 200)}` : '';
      return `• ${when} — ${action}${name ? ` by ${name}` : ''}${detail}`;
    })
    .join('\n');
}
