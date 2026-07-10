import type { Task } from '../core/models/task.js';
import type { Application } from '../core/models/application.js';
import { isMediaSubmission, type Submission } from '../core/models/submission.js';
import type { HistoryEntry } from '../core/models/history.js';
import { TaskStatus, ApplicationStatus, SubmissionStatus } from '../core/workflow.js';
import { getContributor, contributorLabel, type Contributor } from '../core/service.js';

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

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${safeSlice(text, max)}…`;
}

/** Hard clamp for a fully-composed outgoing message (Telegram's 4096-char limit). */
export function clampMessage(text: string): string {
  return text.length > 4096 ? `${safeSlice(text, 4094)}…` : text;
}

/** Surrogate-safe clamp for a media caption (Telegram's 1024-char limit). */
export function clampCaption(text: string): string {
  return safeSlice(text, 1024);
}

function who(id: number | null | undefined): string {
  if (!id) return 'someone';
  const c = getContributor(id);
  return c ? contributorLabel(c) : `user ${id}`;
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

// ---- Tasks ----

export function taskLine(task: Task): string {
  const reward = task.reward ? ` · 🎁 ${truncate(task.reward, 80)}` : '';
  const slots = task.max_assignees > 1 ? ` · 👥 ${task.max_assignees}` : '';
  return `#${task.id} ${truncate(task.title, 120)}${reward}${slots}`;
}

export function taskDetail(task: Task, assignedCount = 0): string {
  const lines = [
    `#${task.id} ${truncate(task.title, 200)}`,
    `Status: ${taskStatusLabel(task.status)}`,
    `Reward: ${task.reward ? truncate(task.reward, 150) : dash}`,
    `Deadline: ${task.deadline ? truncate(task.deadline, 150) : dash}`,
    `Required output: ${task.required_output ? truncate(task.required_output, 500) : dash}`,
    `Assignees: ${assignedCount}/${task.max_assignees}`,
    '',
    truncate(task.description || '(no description)', 1500),
  ];
  return clampMessage(lines.join('\n'));
}

// ---- Contributors ----

const counters = (c: Contributor): string =>
  `applied ${c.applied_count} · assigned ${c.assigned_count} · completed ${c.completed_count} · rejected ${c.rejected_count}`;

export function contributorProfile(c: Contributor): string {
  return [`👤 ${contributorLabel(c)}`, counters(c)].join('\n');
}

// Admin-card variant: includes the numeric Telegram id because it is what
// /forget takes (usernames change; the id is the stable identifier). Labelled
// "user N", never "id N" — "id N" on these cards means the APPLICATION id, and
// an admin who confuses the two would /forget the wrong person.
function contributorStats(c: Contributor): string {
  return `👤 ${contributorLabel(c)} (user ${c.telegram_id}) — ${counters(c)}`;
}

// ---- Applications ----

/** An applicant's pitch plus their track record, for the admin to choose from. */
export function applicantCard(app: Application): string {
  const c = getContributor(app.contributor_id);
  const pitch = app.pitch ? `\n💬 “${truncate(app.pitch, 800)}”` : '\n💬 (no pitch)';
  return clampMessage(
    `${c ? contributorStats(c) : who(app.contributor_id)} · ${applicationStatusLabel(app.status)} · id ${app.id}${pitch}`,
  );
}

/** One row in a contributor's /myapps list. */
export function applicationLine(app: Application, task: Task | undefined, latest?: Submission): string {
  const title = task ? truncate(task.title, 100) : `task #${app.task_id}`;
  const work = latest ? ` · work: ${submissionStatusLabel(latest.status)} v${latest.version}` : '';
  // "id N" is the application id that /submit, /withdraw, and /unassign take.
  return `#${app.task_id} ${title} — ${applicationStatusLabel(app.status)}${work} · id ${app.id}`;
}

// ---- Submissions ----

// Card clip thresholds — shared with submissionTruncated so the "Full
// submission" button appears exactly when the card actually clipped.
const CAPTION_CLIP = 300;
const CONTENT_CLIP = 1000;

// Submission-card clip: unlike plain truncate, says the full text survives —
// the reviewer retrieves it with the "Full submission" button.
function clipStored(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${safeSlice(text, max)}… (truncated — full content is stored)`;
}

function describeSubmission(sub: Submission): string {
  if (isMediaSubmission(sub.type)) {
    const cap = sub.caption ? ` — “${clipStored(sub.caption, CAPTION_CLIP)}”` : '';
    return `(${sub.type === 'video' ? 'video' : 'file'} attachment${cap})`;
  }
  return clipStored(sub.content, CONTENT_CLIP);
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
 * chars (captions at 1024), so today this always fits a single message.
 */
export function fullSubmissionText(sub: Submission): string {
  if (isMediaSubmission(sub.type)) return sub.caption ?? '(no caption)';
  return sub.content;
}

/** Split text into ≤4096-char surrogate-safe pieces (Telegram's message cap). */
export function chunkMessage(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 4096) {
    const head = safeSlice(rest, 4096);
    parts.push(head);
    rest = rest.slice(head.length);
  }
  parts.push(rest);
  return parts;
}

/** Full review card: the work, its version, the task, and the worker's record. */
export function submissionReviewCard(sub: Submission, app: Application, task: Task | undefined): string {
  const c = getContributor(app.contributor_id);
  const lines = [
    task ? `#${task.id} ${truncate(task.title, 200)}` : `task #${app.task_id}`,
    `Required output: ${task?.required_output ? truncate(task.required_output, 400) : dash}`,
    c ? contributorStats(c) : who(app.contributor_id),
    '',
    `📎 Submission v${sub.version} (${sub.type}): ${describeSubmission(sub)}`,
  ];
  if (sub.reviewer_note) lines.push(`📝 Prior note: ${truncate(sub.reviewer_note, 400)}`);
  return clampMessage(lines.join('\n'));
}

// ---- Active board ----

export function activeLine(app: Application, task: Task | undefined, latest?: Submission): string {
  const title = task ? truncate(task.title, 90) : `task #${app.task_id}`;
  const state = latest ? submissionStatusLabel(latest.status) : 'not yet submitted';
  return `• #${app.task_id} ${title} — ${who(app.contributor_id)} · ${state} · updated ${age(app.updated_at)} ago · id ${app.id}`;
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

export function historyBlock(entries: HistoryEntry[]): string {
  if (entries.length === 0) return 'No history yet.';
  // The same few actors recur across a task's history — resolve each once.
  const names = new Map<number, string>();
  return entries
    .map((e) => {
      const when = e.created_at.slice(0, 16).replace('T', ' ');
      const name = e.actor_id ? names.get(e.actor_id) ?? who(e.actor_id) : '';
      if (e.actor_id && !names.has(e.actor_id)) names.set(e.actor_id, name);
      const label = ACTION_LABELS[e.action] ?? e.action;
      // Render the recorded detail (unassign reason, pitch, reviewer note) —
      // it is the audit trail's substance, not just its timestamps.
      const detail = e.detail ? ` · ${truncate(e.detail, 200)}` : '';
      return `• ${when} — ${label}${name ? ` by ${name}` : ''}${detail}`;
    })
    .join('\n');
}
