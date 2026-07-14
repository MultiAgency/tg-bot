import { os } from '@orpc/server';
import { z } from 'zod';
import type { TelegramUser } from './auth.js';
import {
  listOpenTasksWithSlots,
  getPublicTask,
  countSlotsTaken,
  applicationsWithContext,
  listPayoutsByContributor,
  payableWalletLink,
  reconcilePayoutOnChain,
} from '../core/service.js';
import { formatNear } from '../near/escrow.js';

/**
 * The Mini App's oRPC API — READ ONLY by design. Every mutation (apply, submit,
 * review) stays in the bot; the web tier only surfaces the open-task board and a
 * contributor's own work, then deep-links back into the bot to act. Each
 * procedure runs with the verified Telegram user in context (set by the Hono
 * initData gate — see server.ts), so `myApplications` is scoped to the caller
 * and can't read anyone else's applications.
 */
const authed = os.$context<{ user: TelegramUser }>();

const TaskSummary = z.object({
  id: z.number(),
  title: z.string(),
  reward: z.string().nullable(),
  deadline: z.string().nullable(),
  maxAssignees: z.number(),
  assigned: z.number(),
});

const openTasks = authed.output(z.array(TaskSummary)).handler(async () => {
  const rows = await listOpenTasksWithSlots();
  return rows.map(({ task, assigned }) => ({
    id: task.id,
    title: task.title,
    reward: task.reward,
    deadline: task.deadline,
    maxAssignees: task.max_assignees,
    assigned,
  }));
});

const taskDetail = authed
  .input(z.object({ taskId: z.number().int() }))
  .output(
    TaskSummary.extend({
      description: z.string(),
      requiredOutput: z.string().nullable(),
      status: z.string(),
    }).nullable(),
  )
  .handler(async ({ input }) => {
    // The service visibility floor: drafts read as absent. initData proves the
    // caller's identity, not entitlement — any Telegram account can open the
    // Mini App, and an unapproved draft must not be enumerable by taskId.
    const t = await getPublicTask(input.taskId);
    if (!t) return null;
    return {
      id: t.id,
      title: t.title,
      reward: t.reward,
      deadline: t.deadline,
      maxAssignees: t.max_assignees,
      assigned: await countSlotsTaken(t.id),
      description: t.description,
      requiredOutput: t.required_output,
      status: t.status,
    };
  });

const myApplications = authed
  .output(
    z.array(
      z.object({
        applicationId: z.number(),
        taskId: z.number(),
        title: z.string(),
        status: z.string(),
        submission: z.object({ version: z.number(), status: z.string() }).nullable(),
      }),
    ),
  )
  .handler(async ({ context }) => {
    const rows = await applicationsWithContext(context.user.id);
    return rows.map(({ application, task, latest }) => ({
      applicationId: application.id,
      taskId: application.task_id,
      title: task?.title ?? `#${application.task_id}`,
      status: application.status,
      submission: latest ? { version: latest.version, status: latest.status } : null,
    }));
  });

const myPayouts = authed
  .output(
    z.array(
      z.object({
        id: z.number(),
        taskId: z.number(),
        reward: z.string(),
        status: z.string(),
        // True when an allocation is funded and unclaimed ON-CHAIN right now —
        // i.e. the Claim button should be live. A read failure yields false (no
        // button offered), never a broken claim.
        claimable: z.boolean(),
        // The live on-chain amount in NEAR, when funded — what the treasury
        // actually deposited, next to the free-text reward it settles.
        amountNear: z.string().nullable(),
      }),
    ),
  )
  .handler(async ({ context }) => {
    const [rows, link] = await Promise.all([
      listPayoutsByContributor(context.user.id),
      payableWalletLink(context.user.id),
    ]);
    // Same settlement rule as /payouts (reconcilePayoutOnChain), so a claim made
    // here shows as claimed on the next load instead of waiting for an admin's
    // /payouts run. Settled rows cost no chain read; the rest run concurrently.
    const recs = await Promise.all(rows.map((p) => reconcilePayoutOnChain(p, link?.account_id)));
    return rows.map((p, i) => ({
      id: p.id,
      taskId: p.task_id,
      reward: p.reward,
      status: recs[i].status,
      claimable: recs[i].funded,
      amountNear: recs[i].amount ? formatNear(recs[i].amount!) : null,
    }));
  });

export const router = { openTasks, taskDetail, myApplications, myPayouts };
export type AppRouter = typeof router;
