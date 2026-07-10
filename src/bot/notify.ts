import type { Telegram } from 'telegraf';
import { config } from '../config.js';
import type { Task } from '../core/models/task.js';
import type { Application } from '../core/models/application.js';
import { isMediaSubmission, type Submission, type MediaSubmissionType } from '../core/models/submission.js';
import type { MediaKind } from '../core/models/notification.js';
import { listAnnounceRecipients, getContributor, type ReviewDecision } from '../core/service.js';
import { enqueue, enqueueMany, type NewNotification } from '../core/models/notification.js';
import { submissionReviewCard, applicantCard, taskLine, clampMessage, clampCaption } from './format.js';
import { reviewButtons, applicantButtons, announceApplyButton } from './keyboards.js';
import { sendMedia } from './worker.js';
import { t, contributorLocale, baseCode } from './i18n.js';

/**
 * Notification producers. These do not talk to Telegram — they render a message
 * and enqueue it. The background worker (worker.ts) delivers it, globally rate-
 * limited and with retries. Every producer returns immediately, so the command
 * handlers that call them never block on delivery.
 */

/** Serialize an inline keyboard to the reply_markup JSON the worker replays. */
function markup(kb: { reply_markup: unknown }): string {
  return JSON.stringify(kb.reply_markup);
}

type Attachment = Pick<NewNotification, 'mediaKind' | 'mediaFileId' | 'caption'>;

/**
 * Fan an alert out to every admin, locale-resolved, in ONE transaction
 * (enqueueMany) — a crash mid-fan-out must not alert some admins and silently
 * skip the rest. subjectId is taken once, up front, because it is the erasure
 * hook (see NewNotification) — a producer that forgot to tag it would silently
 * exempt its rows from /forget.
 */
function enqueueForAdmins(
  subjectId: number | null,
  payloads: (adminId: number, locale: string) => Omit<NewNotification, 'chatId' | 'subjectId'>[],
): void {
  const rows: NewNotification[] = [];
  for (const adminId of config.adminIds) {
    for (const payload of payloads(adminId, contributorLocale(adminId))) {
      rows.push({ ...payload, chatId: String(adminId), subjectId });
    }
  }
  if (rows.length) enqueueMany(rows);
}

// Submission type → Telegram send method. A file_id only replays through the
// method family it came from (a video file_id 400s through sendDocument).
const MEDIA_KINDS: Record<MediaSubmissionType, MediaKind> = {
  screenshot: 'photo',
  file: 'document',
  video: 'video',
};

/** The raw file/screenshot/video behind a submission, as a media notification — or null for text/link. */
function submissionAttachment(sub: Submission, locale: string): Attachment | null {
  if (!isMediaSubmission(sub.type)) return null;
  return {
    mediaKind: MEDIA_KINDS[sub.type],
    mediaFileId: sub.content,
    caption: clampCaption(t(locale, 'notify.submissionCaption', { version: sub.version, caption: sub.caption ?? '' })),
  };
}

/** Alert every reviewer that a submission arrived: the review card + its attachment. */
export function notifyReviewers(sub: Submission, app: Application, task: Task | undefined): void {
  const card = submissionReviewCard(sub, app, task);
  enqueueForAdmins(app.contributor_id, (adminId, L) => {
    const media = submissionAttachment(sub, L);
    return [
      {
        dedupKey: `rev-alert:${sub.id}:${adminId}`,
        text: clampMessage(t(L, 'notify.reviewHeader', { card })),
        replyMarkup: markup(reviewButtons(sub, L)),
      },
      ...(media ? [{ dedupKey: `rev-attach:${sub.id}:${adminId}`, ...media }] : []),
    ];
  });
}

/**
 * Optional AI enrichment, delivered as a follow-up to an already-queued review
 * alert. Deliberately a separate notification: the durable alert must never
 * wait on (or be lost to) the model — see the submit scene, which enqueues the
 * alert first and computes this note detached from the user's update queue.
 */
export function notifyReviewerNote(sub: Submission, app: Application, note: string): void {
  // The note arrives up to a minute after the submission. If the contributor
  // was erased meanwhile, enqueueing would resurrect data /forget just purged.
  // (Synchronous check-then-enqueue: nothing can interleave in between.)
  if (!getContributor(app.contributor_id)) return;
  enqueueForAdmins(app.contributor_id, (adminId, L) => [
    {
      dedupKey: `rev-note:${sub.id}:${adminId}`,
      text: clampMessage(t(L, 'notify.reviewAiNote', { taskId: app.task_id, version: sub.version, note })),
    },
  ]);
}

/** DM the assignee how their submission was reviewed. */
export function notifyContributorReview(
  submissionId: number,
  contributorId: number,
  task: Task | undefined,
  decision: ReviewDecision,
  note: string | null,
): void {
  const L = contributorLocale(contributorId);
  // Raw parts only — the catalog composes the sentence (fallback wording for a
  // missing task, the note line) so every fragment is translatable.
  const p = { taskId: task?.id ?? null, title: task?.title ?? '', note };
  let text: string;
  if (decision === 'approve') {
    text = t(L, 'notify.reviewApproved', { ...p, reward: task?.reward ?? null });
  } else if (decision === 'reject') {
    text = t(L, 'notify.reviewRejected', p);
  } else {
    text = t(L, 'notify.reviewRevise', p);
  }
  enqueue({
    dedupKey: `rev-out:${submissionId}:${contributorId}`,
    chatId: String(contributorId),
    subjectId: contributorId,
    text: clampMessage(text),
  });
}

export type ApplicantOutcome = 'assigned' | 'declined' | 'unassigned';

/** DM a contributor the outcome of their application (assigned / declined / unassigned). */
export function notifyApplicant(app: Application, task: Task | undefined, outcome: ApplicantOutcome, reason?: string): void {
  const L = contributorLocale(app.contributor_id);
  const p = { taskId: task?.id ?? null, title: task?.title ?? '' };
  let text: string;
  if (outcome === 'assigned') {
    text = t(L, 'notify.assigned', p);
  } else if (outcome === 'declined') {
    text = t(L, 'notify.declined', p);
  } else {
    text = t(L, 'notify.unassigned', { ...p, reason: reason ?? '' });
  }
  // app.updated_at moves on every status change, so re-assign after unassign is a
  // distinct notification rather than a dedup collision on the reused row.
  enqueue({
    dedupKey: `applicant:${outcome}:${app.id}:${app.updated_at}`,
    chatId: String(app.contributor_id),
    subjectId: app.contributor_id,
    text: clampMessage(text),
  });
}

/** Alert every admin that an application arrived, with one-tap Assign/Decline buttons. */
export function notifyAdminsOfApplication(app: Application, task: Task | undefined): void {
  const card = applicantCard(app);
  enqueueForAdmins(app.contributor_id, (adminId, L) => {
    const header = task
      ? t(L, 'notify.applicationHeaderTask', { line: taskLine(task) })
      : t(L, 'notify.applicationHeaderId', { id: app.task_id });
    return [
      {
        dedupKey: `app-alert:${app.id}:${app.updated_at}:${adminId}`,
        text: clampMessage(t(L, 'notify.newApplication', { header, card })),
        replyMarkup: markup(applicantButtons(app, L)),
      },
    ];
  });
}

/**
 * Announce a newly opened task. The announcement channel (if configured) is the
 * primary, O(1) public-discovery post — with a deep-link Apply button when the
 * bot @username is known. Opt-in DMs (contributors who ran /notify on) are a
 * secondary fan-out, enqueued in one transaction. Both are best-effort; /open
 * stays the canonical list. If no channel is configured, approval is unaffected.
 */
export function announceOpenTask(task: Task): void {
  const line = taskLine(task);
  if (config.announceChatId) {
    enqueue({
      dedupKey: `announce-chat:${task.id}`,
      chatId: config.announceChatId,
      subjectId: null, // task-only content
      text: clampMessage(t('en', 'notify.announceChat', { line })),
      replyMarkup: config.botUsername ? markup(announceApplyButton(task, config.botUsername, 'en')) : null,
    });
  }
  const dms = listAnnounceRecipients()
    .filter((c) => !config.adminIds.has(c.telegram_id))
    .map((c) => ({
      dedupKey: `announce-dm:${task.id}:${c.telegram_id}`,
      chatId: String(c.telegram_id),
      subjectId: null, // task-only content; erasure covers the row via chat_id
      // language_code is already on the row from listAnnounceRecipients — resolve
      // the locale directly instead of a per-recipient getContributor round-trip.
      text: clampMessage(t(baseCode(c.language_code), 'notify.announceDm', { line })),
    }));
  if (dms.length) enqueueMany(dms);
}

/**
 * Send a submission's raw file/screenshot directly (not via the queue): this is a
 * synchronous response to the admin viewing /review, not a bot-initiated push.
 */
export async function sendSubmissionAttachment(telegram: Telegram, chatId: number, sub: Submission): Promise<void> {
  const media = submissionAttachment(sub, contributorLocale(chatId));
  if (!media) return;
  await sendMedia(telegram, chatId, { kind: media.mediaKind!, fileId: media.mediaFileId!, caption: media.caption ?? undefined });
}
