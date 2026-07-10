import { Scenes } from 'telegraf';
import {
  type BotContext,
  SCENES,
  messageText,
  wizardState,
  handledWizardInterrupt,
  requirePrivateChat,
} from '../context.js';
import * as ai from '../../ai/assist.js';
import {
  getApplication,
  getTask,
  latestSubmission,
  submitWork,
  errorMessage,
} from '../../core/service.js';
import { ApplicationStatus, SubmissionStatus } from '../../core/workflow.js';
import type { SubmissionType } from '../../core/models/submission.js';
import { notifyReviewers, notifyReviewerNote } from '../notify.js';
import { truncate } from '../format.js';
import { t, localeOf } from '../i18n.js';

interface Extracted {
  type: SubmissionType;
  content: string;
  caption: string | null;
}

// Security invariant: media submissions carry a genuine Telegram file_id (from
// msg.photo/msg.document/msg.video), never user-typed text — the send methods
// also accept URLs, so a typed 'file' would be an SSRF vector.
function extractSubmission(ctx: BotContext): Extracted | null {
  const msg = ctx.message;
  if (!msg) return null;
  if ('photo' in msg && msg.photo?.length) {
    return { type: 'screenshot', content: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption?.trim() || null };
  }
  if ('document' in msg && msg.document) {
    return { type: 'file', content: msg.document.file_id, caption: msg.caption?.trim() || null };
  }
  // Telegram's default for a gallery-picked video (compressed): msg.video, not
  // msg.document. Without this branch the natural way to send a video is refused.
  if ('video' in msg && msg.video) {
    return { type: 'video', content: msg.video.file_id, caption: msg.caption?.trim() || null };
  }
  if ('text' in msg && typeof msg.text === 'string') {
    const t = msg.text.trim();
    if (!t) return null;
    return { type: /^https?:\/\/\S+$/i.test(t) ? 'link' : 'text', content: t, caption: null };
  }
  return null;
}

/** Captures work for an assigned application (a new version). Entered with { applicationId }. */
export const submitScene = new Scenes.WizardScene<BotContext>(
  SCENES.submit,
  // step 0 — validate the application
  async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateChat(ctx))) return ctx.scene.leave();
    const applicationId = wizardState(ctx).applicationId;
    const uid = ctx.from!.id;
    const app = applicationId ? getApplication(applicationId) : undefined;

    if (!app || app.contributor_id !== uid) {
      await ctx.reply(t(L, 'sub.notYours'));
      return ctx.scene.leave();
    }
    if (app.status === ApplicationStatus.Completed) {
      await ctx.reply(t(L, 'sub.alreadyApproved'));
      return ctx.scene.leave();
    }
    if (app.status !== ApplicationStatus.Assigned) {
      await ctx.reply(t(L, 'sub.notAssigned'));
      return ctx.scene.leave();
    }
    const latest = latestSubmission(app.id);
    if (latest && latest.status === SubmissionStatus.Submitted) {
      await ctx.reply(t(L, 'sub.awaitingReview'));
      return ctx.scene.leave();
    }
    // No approved/rejected-latest check: a review decision moved the
    // application to Completed/Rejected atomically, so the status checks
    // above already cover both.

    const task = getTask(app.task_id);
    // Truncated: a raw near-4096-char title would make this reply throw, and a
    // scene whose step-0 prompt never sends leaves the user trapped in the wizard.
    await ctx.reply(t(L, 'sub.prompt', { id: app.task_id, title: task ? truncate(task.title, 200) : '' }));
    return ctx.wizard.next();
  },
  // step 1 — capture and record the submission
  async (ctx) => {
    const L = localeOf(ctx);
    if (await handledWizardInterrupt(ctx, messageText(ctx))) return;

    const state = wizardState(ctx);
    const applicationId = state.applicationId!;
    const uid = ctx.from!.id;
    // An album arrives as separate photo/document messages sharing a
    // media_group_id. Accepting the first would silently drop the rest (the
    // submission records ONE file), so refuse the whole album and ask for a
    // single message — warning once per album, not once per photo.
    const msg = ctx.message;
    const mediaGroupId = msg && 'media_group_id' in msg ? msg.media_group_id : undefined;
    if (mediaGroupId) {
      if (state.warnedMediaGroupId !== mediaGroupId) {
        state.warnedMediaGroupId = mediaGroupId;
        await ctx.reply(t(L, 'sub.albumNotSupported'));
      }
      return; // stay on this step
    }
    const extracted = extractSubmission(ctx);
    if (!extracted) {
      await ctx.reply(t(L, 'sub.sendWork'));
      return; // stay on this step
    }

    // Only the mutation is inside the try: once it commits, a failure in the
    // notify/reply below must surface in bot.catch, not as a false "failed".
    let sub;
    try {
      sub = submitWork(applicationId, uid, extracted.type, extracted.content, extracted.caption);
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'sub.fail')));
      return ctx.scene.leave();
    }
    const app = getApplication(applicationId)!;
    const task = getTask(app.task_id);
    // The durable reviewer alert is enqueued before anything can fail or
    // wait: "Reviewers will be notified" below must already be true when the
    // contributor reads it.
    notifyReviewers(sub, app, task);
    await ctx.reply(t(L, 'sub.ok', { version: sub.version, taskId: app.task_id }));
    const aiText =
      extracted.type === 'text' || extracted.type === 'link' ? extracted.content : extracted.caption;
    if (ai.aiEnabled() && aiText && task) {
      // Optional enrichment, detached: it must never hold this user's
      // serialized update queue for the model's 30s timeout, and a crash here
      // only loses the note — the alert above is already queued. reviewNote
      // never rejects (it degrades to null); the catch covers enqueue errors.
      const submission = sub;
      void ai
        .reviewNote(task, aiText)
        .then((note) => (note ? notifyReviewerNote(submission, app, note) : undefined))
        .catch((err) => console.error('[submit] AI note enqueue failed:', err));
    }
    return ctx.scene.leave();
  },
);
