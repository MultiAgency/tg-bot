import { Scenes } from 'telegraf';
import {
  type BotContext,
  SCENES,
  messageText,
  wizardState,
  handledWizardInterrupt,
  requirePrivateChat,
} from '../context.js';
import {
  getApplication,
  getTask,
  getSubmission,
  reviewSubmission,
  errorMessage,
} from '../../core/service.js';
import { SubmissionStatus } from '../../core/workflow.js';
import { notifyContributorReview } from '../notify.js';
import { t, localeOf } from '../i18n.js';

/** Captures a reviewer note for a reject/revise decision. Entered with { submissionId, decision }. */
export const reviewNoteScene = new Scenes.WizardScene<BotContext>(
  SCENES.review,
  // step 0 — validate the entry state (already in wizard state), prompt for a note
  async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateChat(ctx))) return ctx.scene.leave();
    const st = wizardState(ctx);
    if (!st.submissionId || !st.decision) {
      await ctx.reply(t(L, 'rev.contextLost'));
      return ctx.scene.leave();
    }
    // Pre-gate what the service must refuse anyway — don't collect a typed-out
    // note for a submission another admin already decided (stale card) or that
    // was erased. (The service re-checks inside the transaction.)
    const sub = getSubmission(st.submissionId);
    if (!sub) {
      await ctx.reply(t(L, 'full.gone'));
      return ctx.scene.leave();
    }
    if (sub.status !== SubmissionStatus.Submitted) {
      await ctx.reply(t(L, 'rev.alreadyDecided', { id: sub.id, status: sub.status }));
      return ctx.scene.leave();
    }
    await ctx.reply(t(L, 'rev.notePrompt'));
    return ctx.wizard.next();
  },
  // step 1 — record the review
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text)) return;
    if (text === null) {
      await ctx.reply(t(L, 'rev.noteText'));
      return; // stay on this step
    }

    const st = wizardState(ctx);
    const note = text === '-' ? null : text;
    // Only the mutation is inside the try: once it commits, a failure in the
    // notify/reply below must surface in bot.catch, not as a false "failed".
    let sub;
    try {
      sub = reviewSubmission(st.submissionId!, ctx.from!.id, st.decision!, note);
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'rev.fail')));
      return ctx.scene.leave();
    }
    const app = getApplication(sub.application_id)!;
    notifyContributorReview(sub.id, app.contributor_id, getTask(app.task_id), st.decision!, note);
    await ctx.reply(t(L, 'rev.recorded', { id: sub.id, status: sub.status }));
    return ctx.scene.leave();
  },
);
