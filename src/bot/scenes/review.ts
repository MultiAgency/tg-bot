import { Scenes, Markup } from 'telegraf';
import {
  type BotContext,
  SCENES,
  messageText,
  wizardState,
  handledWizardInterrupt,
  requirePrivateChat,
} from '../context.js';
import {
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
    const sub = await getSubmission(st.submissionId);
    if (!sub) {
      await ctx.reply(t(L, 'full.gone'));
      return ctx.scene.leave();
    }
    if (sub.status !== SubmissionStatus.Submitted) {
      await ctx.reply(t(L, 'rev.alreadyDecided', { id: sub.id, status: sub.status }));
      return ctx.scene.leave();
    }
    // A one-tap Skip beats remembering the "-" convention; the placeholder hints
    // the field. one_time hides the key after a tap; typing a note instead is
    // still fine (the final reply removes the keyboard either way).
    await ctx.reply(
      t(L, 'rev.notePrompt'),
      Markup.keyboard([[t(L, 'rev.skipButton')]])
        .oneTime()
        .resize()
        .placeholder(t(L, 'rev.notePlaceholder')),
    );
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
    // Skip via the button, or the legacy "-" typed convention.
    const note = text === '-' || text === t(L, 'rev.skipButton') ? null : text;
    // Only the mutation is inside the try: once it commits, a failure in the
    // notify/reply below must surface in bot.catch, not as a false "failed".
    let result;
    try {
      result = await reviewSubmission(st.submissionId!, ctx.from!.id, st.decision!, note);
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'rev.fail')), Markup.removeKeyboard());
      return ctx.scene.leave();
    }
    const { submission, application, task } = result;
    await notifyContributorReview(submission.id, application.contributor_id, task, st.decision!, note);
    // Drop the Skip keyboard now the step is done.
    await ctx.reply(t(L, 'rev.recorded', { id: submission.id, status: submission.status }), Markup.removeKeyboard());
    return ctx.scene.leave();
  },
);
