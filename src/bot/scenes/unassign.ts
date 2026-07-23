import { Scenes } from 'telegraf';
import {
  type BotContext,
  SCENES,
  messageText,
  wizardState,
  handledWizardInterrupt,
  finishScene,
  requirePrivateChat,
} from '../context.js';
import {
  getApplication,
  getTask,
  latestSubmission,
  unassignApplication,
  errorMessage,
} from '../../core/service.js';
import { leaveUnlessTaskManager } from './guards.js';
import { withTransaction } from '../../core/db.js';
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
    const app = applicationId ? await getApplication(applicationId) : undefined;
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
    const latest = await latestSubmission(app.id);
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
    // Commit-time manager re-check (leaveUnlessTaskManager — shared with the
    // review-note wizard): a demotion mid-wizard must not still unassign.
    const app = await getApplication(applicationId);
    if (!app) {
      await ctx.reply(t(L, 'un.notFound'));
      return ctx.scene.leave();
    }
    const task = await getTask(app.task_id);
    if (!(await leaveUnlessTaskManager(ctx, task))) return;
    // The unassign and its outcome DM commit together: the DM is one-shot (a
    // retry throws "not assigned", so its dedup key is never revisited) —
    // enqueued after the commit, a crash between the two would lose it
    // permanently. A failure rolls both back; the admin just retries.
    // finishScene owns reply-and-leave on every path.
    return finishScene(
      ctx,
      () =>
        withTransaction(async () => {
          const { application, task } = await unassignApplication(applicationId, ctx.from!.id, text);
          await notifyApplicant(application, task, 'unassigned', text);
        }),
      () => ctx.reply(t(L, 'un.done')),
      (err) => ctx.reply(errorMessage(err, t(L, 'un.fail'))),
    );
  },
);
