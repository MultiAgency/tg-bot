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
  latestSubmission,
  unassignApplication,
  errorMessage,
} from '../../core/service.js';
import { ApplicationStatus, SubmissionStatus } from '../../core/workflow.js';
import { notifyApplicant } from '../notify.js';
import { t, localeOf } from '../i18n.js';

/** Captures a required reason, then unassigns. Entered with { applicationId }. */
export const unassignScene = new Scenes.WizardScene<BotContext>(
  SCENES.unassign,
  // step 0 — prompt for the reason
  async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateChat(ctx))) return ctx.scene.leave();
    const applicationId = wizardState(ctx).applicationId;
    const app = applicationId ? getApplication(applicationId) : undefined;
    if (!app) {
      await ctx.reply(t(L, 'un.notFound'));
      return ctx.scene.leave();
    }
    // Pre-gate what the service must refuse anyway — don't collect a typed-out
    // reason for an unassign that is guaranteed to fail. (The service re-checks
    // inside the transaction; this is the UX gate.)
    if (app.status !== ApplicationStatus.Assigned) {
      await ctx.reply(t(L, 'un.notAssigned', { status: app.status }));
      return ctx.scene.leave();
    }
    const latest = latestSubmission(app.id);
    if (latest && latest.status === SubmissionStatus.Submitted) {
      await ctx.reply(t(L, 'un.pendingReview', { version: latest.version }));
      return ctx.scene.leave();
    }
    await ctx.reply(t(L, 'un.reasonPrompt'));
    return ctx.wizard.next();
  },
  // step 1 — record with the reason
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text)) return;
    if (!text) {
      await ctx.reply(t(L, 'un.reasonRequired'));
      return; // stay on this step — a reason is required
    }
    const applicationId = wizardState(ctx).applicationId!;
    // Only the mutation is inside the try: once it commits, a failure in the
    // notify/reply below must surface in bot.catch, not as a false "failed".
    let app;
    try {
      app = unassignApplication(applicationId, ctx.from!.id, text);
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'un.fail')));
      return ctx.scene.leave();
    }
    notifyApplicant(app, getTask(app.task_id), 'unassigned', text);
    await ctx.reply(t(L, 'un.done'));
    return ctx.scene.leave();
  },
);
