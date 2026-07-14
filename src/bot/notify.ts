import type { Telegram } from 'telegraf';
import { config } from '../config.js';
import type { Task } from '../core/models/task.js';
import type { Application } from '../core/models/application.js';
import { isMediaSubmission, type Submission, type MediaSubmissionType } from '../core/models/submission.js';
import type { MediaKind } from '../core/models/notification.js';
import {
  listAnnounceRecipients,
  getContributorForUpdate,
  taskManagerIds,
  type Contributor,
  type ReviewDecision,
} from '../core/service.js';
import { withTransaction } from '../core/db.js';
import { enqueue, enqueueMany, type NewNotification } from '../core/models/notification.js';
import { submissionReviewCard, applicantCard, taskLine, clampMessage, clampCaption } from './format.js';
import { reviewButtons, applicantButtons, deepLinkApplyButton } from './keyboards.js';
import { sendMedia } from './worker.js';
import { t, contributorLocale, contributorLocales, baseCode } from './i18n.js';

/**
 * Notification producers. These do not talk to Telegram — they render a message
 * and enqueue it. The background worker (worker.ts) delivers it, globally rate-
 * limited and with retries. Producers only touch the DB (locale lookups + the
 * insert), so callers can await them cheaply or fire-and-forget the fan-outs.
 */

/** Serialize an inline keyboard to the reply_markup JSON the worker replays. */
function markup(kb: { reply_markup: unknown }): string {
  return JSON.stringify(kb.reply_markup);
}

type Attachment = Pick<NewNotification, 'mediaKind' | 'mediaFileId' | 'caption'>;

/**
 * Fan an alert out to a recipient set, locale-resolved, in ONE transaction
 * (enqueueMany) — a crash mid-fan-out must not alert some recipients and
 * silently skip the rest. subjectId is taken once, up front, because it is the
 * erasure hook (see NewNotification) — a producer that forgot to tag it would
 * silently exempt its rows from /forget.
 */
async function enqueueFor(
  recipientIds: Iterable<number>,
  subjectId: number | null,
  payloads: (recipientId: number, locale: string) => Omit<NewNotification, 'chatId' | 'subjectId'>[],
): Promise<void> {
  const ids = [...recipientIds];
  const locales = await contributorLocales(ids); // one query for the whole set, not one per recipient
  const rows: NewNotification[] = [];
  for (const id of ids) {
    for (const payload of payloads(id, locales.get(id)!)) {
      rows.push({ ...payload, chatId: String(id), subjectId });
    }
  }
  if (rows.length) await enqueueMany(rows);
}

/** Fan out to every global admin (ops alerts, room registrations). */
export function enqueueForAdmins(
  subjectId: number | null,
  payloads: (adminId: number, locale: string) => Omit<NewNotification, 'chatId' | 'subjectId'>[],
): Promise<void> {
  return enqueueFor(config.adminIds, subjectId, payloads);
}

/**
 * Fan out to everyone who can act on this task: global admins plus, for a room
 * task, that room's admins. Task-scoped alerts (applications, submissions, AI
 * notes, signal drafts) use this — a room admin who is expected to review work
 * must hear about it, not just those in ADMIN_IDS.
 */
export async function enqueueForManagers(
  task: Pick<Task, 'room_chat_id'> | undefined,
  subjectId: number | null,
  payloads: (managerId: number, locale: string) => Omit<NewNotification, 'chatId' | 'subjectId'>[],
): Promise<void> {
  await enqueueFor(await taskManagerIds(task), subjectId, payloads);
}

/**
 * Run a PII-bearing enqueue under the subject contributor's erasure lock. Every
 * producer that carries a contributor's data (pitch, name, work, an outcome DM)
 * runs AFTER its mutation committed and released that mutation's lock — so a
 * concurrent /forget could purge the contributor in that gap, and rows inserted
 * here would escape deleteForContributor and reach a manager (or the contributor
 * themselves) after the admin was told the erasure was complete. Taking the same
 * row lock /forget takes (getContributorForUpdate) closes the window: either we
 * commit first and the later purge covers our rows, or the purge wins and the
 * locked read comes back empty so we skip. The locked row is handed to the
 * builder so cards and locale render from it without a second read.
 *
 * NOT for producers whose subject may legitimately have no contributor row
 * (announcements, the room-registration alert, the room-admin promotion DM) —
 * the empty read would wrongly suppress them; those pass subjectId to
 * deleteForContributor's chat_id/subject_id sweep instead.
 */
async function enqueueAboutContributor(
  contributorId: number,
  build: (contributor: Contributor, locale: string) => Promise<void>,
): Promise<void> {
  await withTransaction(async () => {
    const contributor = await getContributorForUpdate(contributorId);
    if (!contributor) return; // erased in the post-commit window — skip
    await build(contributor, baseCode(contributor.language_code));
  });
}

// Submission type → Telegram send method. A file_id only replays through the
// method family it came from (a video file_id 400s through sendDocument).
const MEDIA_KINDS: Record<MediaSubmissionType, MediaKind> = {
  screenshot: 'photo',
  file: 'document',
  video: 'video',
  video_note: 'video_note',
};

/** The raw file/screenshot/video behind a submission, as a media notification — or null for text/link. */
function submissionAttachment(sub: Submission, locale: string): Attachment | null {
  if (!isMediaSubmission(sub.type)) return null;
  const kind = MEDIA_KINDS[sub.type];
  return {
    mediaKind: kind,
    mediaFileId: sub.content,
    // sendVideoNote has no caption parameter — version context lives on the
    // review card, so a video note's attachment carries none.
    caption:
      kind === 'video_note'
        ? null
        : clampCaption(t(locale, 'notify.submissionCaption', { version: sub.version, caption: sub.caption ?? '' })),
  };
}

/** Alert every reviewer that a submission arrived: the review card + its attachment. */
export async function notifyReviewers(sub: Submission, app: Application, task: Task | undefined): Promise<void> {
  await enqueueAboutContributor(app.contributor_id, async (contributor) => {
    const card = submissionReviewCard(sub, app, task, contributor);
    await enqueueForManagers(task, app.contributor_id, (adminId, L) => {
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
  });
}

/**
 * Optional AI enrichment, delivered as a follow-up to an already-queued review
 * alert. Deliberately a separate notification: the durable alert must never
 * wait on (or be lost to) the model — see the submit scene, which enqueues the
 * alert first and computes this note detached from the user's update queue.
 */
export async function notifyReviewerNote(sub: Submission, app: Application, task: Task | undefined, note: string): Promise<void> {
  // The note arrives up to a minute after the submission; enqueueAboutContributor
  // skips it if /forget purged the contributor meanwhile (locked check-then-insert).
  await enqueueAboutContributor(app.contributor_id, async () => {
    await enqueueForManagers(task, app.contributor_id, (adminId, L) => [
      {
        dedupKey: `rev-note:${sub.id}:${adminId}`,
        text: clampMessage(t(L, 'notify.reviewAiNote', { taskId: app.task_id, version: sub.version, note })),
      },
    ]);
  });
}

/** DM the assignee how their submission was reviewed. */
export async function notifyContributorReview(
  submissionId: number,
  contributorId: number,
  task: Task | undefined,
  decision: ReviewDecision,
  note: string | null,
): Promise<void> {
  await enqueueAboutContributor(contributorId, async (_c, L) => {
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
    await enqueue({
      dedupKey: `rev-out:${submissionId}:${contributorId}`,
      chatId: String(contributorId),
      subjectId: contributorId,
      text: clampMessage(text),
    });
  });
}

export type ApplicantOutcome = 'assigned' | 'declined' | 'unassigned';

/** DM a contributor the outcome of their application (assigned / declined / unassigned). */
export async function notifyApplicant(app: Application, task: Task | undefined, outcome: ApplicantOutcome, reason?: string): Promise<void> {
  await enqueueAboutContributor(app.contributor_id, async (_c, L) => {
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
    await enqueue({
      dedupKey: `applicant:${outcome}:${app.id}:${app.updated_at}`,
      chatId: String(app.contributor_id),
      subjectId: app.contributor_id,
      text: clampMessage(text),
    });
  });
}

/** Alert every manager that an application arrived, with one-tap Assign/Decline buttons. */
export async function notifyAdminsOfApplication(app: Application, task: Task | undefined): Promise<void> {
  await enqueueAboutContributor(app.contributor_id, async (contributor) => {
    const card = applicantCard(app, contributor);
    await enqueueForManagers(task, app.contributor_id, (adminId, L) => {
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
  });
}

/**
 * Build the notification rows for a newly opened task: the announcement channel
 * post (if configured — the primary, O(1) discovery surface, with a deep-link
 * Apply button when the bot @username is known) plus the opt-in DM fan-out
 * (contributors who ran /notify on). Does the audience SELECT and row
 * construction with NO transaction, so a caller can run this launch-scale work
 * OUTSIDE the approval lock and enqueue the result atomically afterward (see
 * enqueueAnnounceRows). Both surfaces are best-effort; /open stays canonical.
 *
 * Safe to build from the pre-approval (Draft) task snapshot: only the status
 * flips on approval, and none of the announced fields (title/reward/deadline)
 * depend on it.
 */
export async function buildAnnounceRows(task: Task): Promise<NewNotification[]> {
  const line = taskLine(task);
  const rows: NewNotification[] = [];
  // A room-scoped task (drafted from — or created for — a group) announces back
  // INTO that group on approval, so the community whose discussion produced it
  // actually sees the opportunity. Task-only content (taskLine carries no PII).
  // Skipped when the room IS the global announce channel, to avoid double-posting.
  if (task.room_chat_id != null && String(task.room_chat_id) !== config.announceChatId) {
    rows.push({
      dedupKey: `announce-room:${task.id}`,
      chatId: String(task.room_chat_id),
      subjectId: null,
      text: clampMessage(t('en', 'notify.announceRoom', { line })),
      replyMarkup: config.botUsername ? markup(deepLinkApplyButton(task, config.botUsername, 'en')) : null,
    });
  }
  if (config.announceChatId) {
    rows.push({
      dedupKey: `announce-chat:${task.id}`,
      chatId: config.announceChatId,
      subjectId: null, // task-only content
      text: clampMessage(t('en', 'notify.announceChat', { line })),
      replyMarkup: config.botUsername ? markup(deepLinkApplyButton(task, config.botUsername, 'en')) : null,
    });
  }
  for (const c of await listAnnounceRecipients()) {
    if (config.adminIds.has(c.telegram_id)) continue; // admins already act on it
    rows.push({
      dedupKey: `announce-dm:${task.id}:${c.telegram_id}`,
      chatId: String(c.telegram_id),
      subjectId: null, // task-only content; erasure covers the row via chat_id
      // language_code is already on the row from listAnnounceRecipients — resolve
      // the locale directly instead of a per-recipient getContributor round-trip.
      text: clampMessage(t(baseCode(c.language_code), 'notify.announceDm', { line })),
    });
  }
  return rows;
}

/**
 * Enqueue prebuilt announcement rows. Call INSIDE the approval transaction so
 * the announce commits atomically with the task going Open — once a task is
 * Open no path re-announces it, so an enqueue committed separately and then lost
 * to a crash would be a permanent miss. Idempotent on dedupKey.
 */
export async function enqueueAnnounceRows(rows: NewNotification[]): Promise<void> {
  if (rows.length) await enqueueMany(rows);
}

/**
 * Alert a task's managers that signal detection auto-drafted it. Task-only
 * content (the AI-distilled draft names no contributor) — subjectId null.
 */
export async function notifySignalDraft(task: Task, roomTitle: string | null): Promise<void> {
  const line = taskLine(task);
  await enqueueForManagers(task, null, (managerId, L) => [
    {
      dedupKey: `signal-draft:${task.id}:${managerId}`,
      text: clampMessage(t(L, 'notify.signalDraft', { line, room: roomTitle })),
    },
  ]);
}

/**
 * Tell global admins the bot was added to a group (and who bootstrapped it as
 * the room's first admin). The inviter's id is their personal data — subjectId.
 */
export async function notifyRoomRegistered(
  chatId: number,
  title: string | null,
  inviterId: number | null,
  eventDate: number,
): Promise<void> {
  await enqueueForAdmins(inviterId, (adminId, L) => [
    {
      dedupKey: `room-added:${chatId}:${eventDate}:${adminId}`,
      text: clampMessage(t(L, 'notify.roomRegistered', { title, chatId, inviterId })),
    },
  ]);
}

/**
 * DM a user they became a room admin. Best-effort by design: someone who never
 * started the bot can't be messaged (403) — the group reply to /addroomadmin
 * says so, and the queue's retry budget absorbs the failure.
 */
export async function notifyRoomAdminPromoted(userId: number, chatId: number, roomTitle: string | null, eventKey: number): Promise<void> {
  await enqueue({
    dedupKey: `room-admin:${chatId}:${userId}:${eventKey}`,
    chatId: String(userId),
    subjectId: userId,
    text: clampMessage(t(await contributorLocale(userId), 'notify.roomAdminPromoted', { title: roomTitle })),
  });
}

/**
 * Send a submission's raw file/screenshot directly (not via the queue): this is a
 * synchronous response to the admin viewing /review, not a bot-initiated push.
 * The reviewer's locale is passed in (not re-read from their stored profile) so
 * the caption matches the review card rendered beside it — the card resolves from
 * the live ctx language — and the /review loop makes no per-attachment round trip.
 */
export async function sendSubmissionAttachment(telegram: Telegram, chatId: number, sub: Submission, locale: string): Promise<void> {
  const media = submissionAttachment(sub, locale);
  if (!media) return;
  await sendMedia(
    telegram,
    chatId,
    { kind: media.mediaKind!, fileId: media.mediaFileId!, caption: media.caption ?? undefined },
    { parse_mode: 'HTML' },
  );
}
