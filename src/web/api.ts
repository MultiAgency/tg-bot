import { os } from '@orpc/server';
import { z } from 'zod';
import type { TelegramUser } from './auth.js';
import {
  listOpenTasksWithSlots,
  getPublicTask,
  countSlotsTaken,
  applicationsWithContext,
  listPayoutsByContributor,
  reconcilePayout,
  proposalWindow,
  pinnedAmountNear,
} from '../core/service.js';
import { PAYOUT_STATUSES } from '../core/models/payout.js';

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
        // The model's vocabulary, not z.string(): renaming/adding a status then
        // fails the build in every web consumer instead of silently rendering
        // the raw DB string.
        status: z.enum(PAYOUT_STATUSES),
        /** The exact pinned on-chain amount once proposed/paid (yoctoNEAR → NEAR),
         *  null while pending — the truth the free-text `reward` can contradict. */
        amountNear: z.string().nullable(),
        /** Needs a human before it moves again (rejected vote / failed transfer /
         *  a live duplicate proposal — the service's separate duplicateProposals
         *  flag folds in here, this surface having only the one bit). */
        attention: z.boolean(),
        /** False when the on-chain state could NOT be verified this load (RPC
         *  failure, or a young in-flight claim) — `status` is then the stored
         *  snapshot, not chain truth, and the UI must say so instead of
         *  rendering it as authoritative (the bot's /payouts does). */
        ok: z.boolean(),
        /** The benign unverified case: a claim whose proposal isn't visible
         *  on-chain YET (in flight / auto-clears) — distinct wording from an
         *  RPC failure. Only meaningful when `ok` is false. */
        held: z.boolean(),
      }),
    ),
  )
  .handler(async ({ context }) => {
    const rows = await listPayoutsByContributor(context.user.id);
    // Same settlement dispatch as /payouts (reconcilePayout), so a DAO vote shows
    // settled on the next load instead of waiting for an admin's /payouts run —
    // and the paid DM fires inside it. Settled rows cost no chain read; the rest
    // run concurrently.
    // One shared (lazy) proposal-window snapshot for the load — not one
    // up-to-1000-proposal fetch per scan-needing row.
    const window = proposalWindow();
    const recs = await Promise.all(rows.map((p) => reconcilePayout(p, window)));
    return rows.map((p, i) => ({
      id: p.id,
      taskId: p.task_id,
      reward: p.reward,
      status: recs[i].status,
      // pinnedAmountNear owns the display invariant (reconciled-status keying),
      // shared with /payouts — see its comment in service.ts.
      amountNear: pinnedAmountNear(p, recs[i]),
      attention: recs[i].attention || Boolean(recs[i].duplicateProposals),
      ok: recs[i].ok,
      held: Boolean(recs[i].held),
    }));
  });

export const router = { openTasks, taskDetail, myApplications, myPayouts };
export type AppRouter = typeof router;
