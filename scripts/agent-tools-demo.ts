/**
 * Agent-tools suite: drives executeAgentTool directly (no model, no API key)
 * against the test DB, verifying the tool guards match the real flows —
 *   - propose_apply mirrors service.apply's guards, so a full / not-open /
 *     already-applied task never dangles an Apply card;
 *   - list_open_tasks flags fullness (open-but-full ≠ applyable);
 *   - create_task_draft is admin-gated and survives a non-numeric maxAssignees
 *     ("a few" → NaN) instead of hitting the integer column.
 * Run: npm run agent-tools-demo (throwaway database).
 */
import assert from 'node:assert';
import { executeAgentTool, type AgentEnv } from '../src/ai/agentTools.js';
import {
  createTask,
  approveTask,
  closeTask,
  apply,
  assignApplication,
  getApplicationFor,
  listDraftTasks,
  upsertContributor,
  registerRoom,
} from '../src/core/service.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';
import { step, ok } from './harness.js';

const ADMIN = Number(process.env.ADMIN_IDS!.split(',')[0]);

function makeEnv(userId: number, isManager: boolean, roomChatId: number | null = null): { env: AgentEnv; replies: string[] } {
  const replies: string[] = [];
  const env: AgentEnv = {
    userId,
    roomChatId,
    locale: 'en',
    isManager,
    isGroup: roomChatId !== null,
    reply: async (text: string) => {
      replies.push(text);
    },
  };
  return { env, replies };
}

const errText = (r: Record<string, unknown>): string => String(r.error ?? '');

async function main(): Promise<void> {
  await resetDb();

  step('seed: an applyable task (2 slots), a full task (1/1), and a draft');
  await upsertContributor(50, 'filler', 'Filler');
  await upsertContributor(60, 'applicant', 'Applicant');
  const applyable = await createTask({ title: 'Applyable', description: 'x', maxAssignees: 2, createdBy: ADMIN });
  await approveTask(applyable.id, ADMIN);
  const full = await createTask({ title: 'Full', description: 'x', maxAssignees: 1, createdBy: ADMIN });
  await approveTask(full.id, ADMIN);
  const draftOnly = await createTask({ title: 'DraftOnly', description: 'x', createdBy: ADMIN }); // never approved
  await apply(full.id, 50, null);
  await assignApplication((await getApplicationFor(full.id, 50))!.id, ADMIN); // fills the single slot
  ok('seeded');

  step('propose_apply mirrors service.apply guards');
  const c = makeEnv(60, false);
  let r = await executeAgentTool(c.env, 'propose_apply', { taskId: applyable.id });
  assert.ok(!('error' in r) && c.replies.length === 1, 'applyable task → an Apply card is shown');
  r = await executeAgentTool(c.env, 'propose_apply', { taskId: full.id });
  assert.ok(errText(r).includes('fully assigned'), 'full task → refused, no card');
  // A draft isn't applyable — and to a contributor it isn't even visible, so
  // propose_apply refuses (no card) via the shared visibility gate with the
  // SAME merged message a missing id gets: a distinguishable refusal ("not
  // open") would be an existence oracle for hidden drafts.
  r = await executeAgentTool(c.env, 'propose_apply', { taskId: draftOnly.id });
  assert.ok(errText(r).includes('not visible'), 'hidden draft → merged not-found/not-visible');
  r = await executeAgentTool(c.env, 'propose_apply', { taskId: 999999 });
  assert.ok(errText(r).includes('not visible'), 'missing id → the same merged message');
  // A closed task is public (visible), so it gets the honest refusal instead.
  const closed = await createTask({ title: 'Closed', description: 'x', createdBy: ADMIN });
  await approveTask(closed.id, ADMIN);
  await closeTask(closed.id, ADMIN);
  r = await executeAgentTool(c.env, 'propose_apply', { taskId: closed.id });
  assert.ok(errText(r).includes('not open'), 'closed (public) task → refused as not open');
  await apply(applyable.id, 60, null); // now 60 has an application on the applyable task
  r = await executeAgentTool(c.env, 'propose_apply', { taskId: applyable.id });
  assert.ok(errText(r).includes('already have an application'), 'already applied → refused');
  ok('full / hidden-draft / closed / already-applied refused; applyable shows a card');

  step('propose_apply respects the max-open-applications cap');
  // The suite runs with MAX_OPEN_APPLICATIONS=2 (see package.json).
  const capA = await createTask({ title: 'CapA', description: 'x', createdBy: ADMIN });
  await approveTask(capA.id, ADMIN);
  const capB = await createTask({ title: 'CapB', description: 'x', createdBy: ADMIN });
  await approveTask(capB.id, ADMIN);
  await upsertContributor(90, 'capper', 'Capper');
  await apply(applyable.id, 90, null); // pending 1
  await apply(capA.id, 90, null); // pending 2 → at the cap
  const capped = await executeAgentTool(makeEnv(90, false).env, 'propose_apply', { taskId: capB.id });
  assert.ok(errText(capped).includes('pending application'), 'user at the cap → refused, no card');
  ok('over the open-application cap → refused');

  step('list_open_tasks flags fullness');
  const list = await executeAgentTool(c.env, 'list_open_tasks', {});
  const byId = new Map((list.tasks as { id: number; full: boolean }[]).map((t) => [t.id, t]));
  assert.equal(byId.get(applyable.id)!.full, false, 'applyable (0/2 assigned) not full');
  assert.equal(byId.get(full.id)!.full, true, 'full task (1/1) flagged full');
  ok('open list distinguishes applyable from open-but-full');

  step('get_task honors visibility (no leaking drafts / other rooms)');
  const ROOM = -100777;
  await registerRoom(ROOM, 'TestRoom', null);
  const roomDraft = await createTask({ title: 'Secret draft', description: 'wip', createdBy: ADMIN, roomChatId: ROOM });
  assert.ok(!('error' in (await executeAgentTool(makeEnv(60, false).env, 'get_task', { taskId: applyable.id }))), 'open task visible to anyone');
  const contribInRoom = await executeAgentTool(makeEnv(80, false, ROOM).env, 'get_task', { taskId: roomDraft.id });
  assert.ok(errText(contribInRoom).includes('not visible'), 'draft hidden from a non-manager in its room');
  const mgrInRoom = await executeAgentTool(makeEnv(ADMIN, true, ROOM).env, 'get_task', { taskId: roomDraft.id });
  assert.ok(!('error' in mgrInRoom), 'draft visible to a manager of its room');
  const mgrOtherRoom = await executeAgentTool(makeEnv(ADMIN, true, -100999).env, 'get_task', { taskId: roomDraft.id });
  assert.ok(errText(mgrOtherRoom).includes('not visible'), 'draft hidden from a manager viewing a different room');
  ok('open public; draft only to its own room’s manager');

  step('create_task_draft: admin-gated, NaN slots safe');
  r = await executeAgentTool(makeEnv(70, false).env, 'create_task_draft', { title: 'X', description: 'y' });
  assert.ok(errText(r).includes('admins'), 'non-admin refused');
  const before = (await listDraftTasks()).length;
  const adminEnv = makeEnv(ADMIN, true);
  r = await executeAgentTool(adminEnv.env, 'create_task_draft', {
    title: 'Release notes',
    description: 'v2 notes',
    maxAssignees: 'a few', // non-numeric → NaN; the guard must fall back, not crash
  });
  assert.ok(!('error' in r) && adminEnv.replies.length === 1, 'admin draft with "a few" slots did not error');
  assert.equal((await listDraftTasks()).length, before + 1, 'the draft was created');
  ok('auth enforced; non-numeric maxAssignees drafts cleanly (NaN guard)');

  console.log('\n✅ AGENT-TOOLS DEMO PASSED — apply/create guards mirror the real flows.');
}

runScript(main);
