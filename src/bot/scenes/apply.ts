import { Scenes } from 'telegraf';
import {
  type BotContext,
  SCENES,
  messageText,
  wizardState,
  handledWizardInterrupt,
  requirePrivateChat,
} from '../context.js';
import { getTask, apply, countSlotsTaken, errorMessage } from '../../core/service.js';
import { truncate } from '../format.js';
import { TaskStatus } from '../../core/workflow.js';
import { notifyAdminsOfApplication } from '../notify.js';
import { t, localeOf } from '../i18n.js';

/** Captures a short pitch, then files the application. Entered with { taskId }. */
export const applyScene = new Scenes.WizardScene<BotContext>(
  SCENES.apply,
  // step 0 — validate the task, prompt for a pitch
  async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateChat(ctx))) return ctx.scene.leave();
    const taskId = wizardState(ctx).taskId;
    const task = taskId ? getTask(taskId) : undefined;
    if (!task || task.status !== TaskStatus.Open) {
      await ctx.reply(t(L, 'apply.notOpen'));
      return ctx.scene.leave();
    }
    // Same fullness gate /open applies before offering an Apply button. The
    // channel deep-link path lands here directly, and its button outlives the
    // task filling up — don't collect a pitch that service.apply must refuse.
    // (service.apply re-checks inside the transaction; this is the UX gate.)
    if (countSlotsTaken(task.id) >= task.max_assignees) {
      await ctx.reply(t(L, 'apply.full', { id: task.id }));
      return ctx.scene.leave();
    }
    // Truncated: a raw near-4096-char title would make this reply throw, and a
    // scene whose step-0 prompt never sends leaves the user trapped in the wizard.
    await ctx.reply(t(L, 'apply.prompt', { id: task.id, title: truncate(task.title, 200) }));
    return ctx.wizard.next();
  },
  // step 1 — record the pitch and apply
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text)) return;
    if (text === null) {
      await ctx.reply(t(L, 'apply.pitchText'));
      return; // stay on this step
    }
    const taskId = wizardState(ctx).taskId!;
    const pitch = text === '-' ? null : text;
    // Only the mutation is inside the try: once it commits, a failure in the
    // notify/reply below must surface in bot.catch, not as a false "failed".
    let app;
    try {
      app = apply(taskId, ctx.from!.id, pitch);
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'apply.fail')));
      return ctx.scene.leave();
    }
    notifyAdminsOfApplication(app, getTask(taskId)); // durable before any send can fail
    await ctx.reply(t(L, 'apply.applied', { id: taskId }));
    return ctx.scene.leave();
  },
);
