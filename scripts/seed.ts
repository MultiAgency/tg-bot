/**
 * Shared DB seed helpers for the demo/live suites — the workflow sequences a
 * scenario needs as a fixture, not as the thing under test. Kept out of
 * harness.ts (the Telegraf transport stub): these drive the service layer
 * directly and have no Telegram surface.
 */
import assert from 'node:assert';
import {
  createTask,
  approveTask,
  apply,
  assignApplication,
  submitWork,
  reviewSubmission,
  listPayoutsByContributor,
  type Payout,
} from '../src/core/service.js';

/**
 * Approve rewarded work → ONE 'pending' payout: the canonical fixture for the
 * payout suites (dao-demo's per-scenario seed, dao-propose-live, core-demo's
 * erasure-vs-money block). Centralized so a workflow-signature change lands
 * here once instead of in every suite. The contributor row must already exist
 * (apply() refuses unknown contributors — upsert before calling).
 */
export async function seedPendingPayout(opts: {
  title: string;
  reward: string;
  admin: number;
  contributor: number;
}): Promise<Payout> {
  const task = await createTask({ title: opts.title, description: 'x', reward: opts.reward, createdBy: opts.admin });
  await approveTask(task.id, opts.admin);
  const app = await apply(task.id, opts.contributor, null);
  await assignApplication(app.id, opts.admin);
  const sub = await submitWork(app.id, opts.contributor, 'text', 'done');
  await reviewSubmission(sub.submission.id, opts.admin, 'approve', null);
  const payout = (await listPayoutsByContributor(opts.contributor)).find((p) => p.task_id === task.id);
  assert.ok(payout, `seed produced no payout for task ${task.id}`);
  assert.equal(payout.status, 'pending');
  return payout;
}
