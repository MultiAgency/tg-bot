import { Markup } from 'telegraf';
import type { BotContext } from '../context.js';
import { canManageTask } from '../../core/service.js';
import type { Task } from '../../core/models/task.js';
import { t, localeOf } from '../i18n.js';

/**
 * Commit-time manager gate shared by the review-note and unassign wizards: a
 * wizard waits indefinitely for its text step, so a room admin demoted
 * mid-wizard must be refused at COMMIT, not just at the entry tap (the service
 * mutators take the actor id as audit data only — the bot layer owns this
 * gate, with the same canManageTask predicate the entry gates use). Replies
 * and leaves the scene when the caller may no longer manage the task;
 * removeKeyboard is a no-op for a scene without a reply keyboard.
 */
export async function leaveUnlessTaskManager(ctx: BotContext, task: Task | undefined): Promise<boolean> {
  if (await canManageTask(ctx.from!.id, task)) return true;
  await ctx.reply(t(localeOf(ctx), 'rooms.roomAdminsOnly'), Markup.removeKeyboard());
  await ctx.scene.leave();
  return false;
}
