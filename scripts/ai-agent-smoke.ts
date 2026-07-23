/**
 * Live smoke for the conversational agent (group /ai mode). Seeds one open task
 * in the test DB, then drives the REAL tool loop (agent.ts) against the REAL
 * NEAR AI endpoint through a fake env that captures replies instead of Telegram.
 * Proves: tool selection (browse), propose-don't-perform (draft shows a card and
 * creates a Draft, never Open), and — the point of the rebuild — a multi-turn
 * clarifying question that uses the answer on the next turn.
 *
 *   DATABASE_URL=postgresql://multiagency:multiagency@localhost:5455/multiagency_test \
 *   BOT_TOKEN=000000:demo ADMIN_IDS=1 npx tsx scripts/ai-agent-smoke.ts
 */
import { config } from '../src/config.js';
import { aiEnabled } from '../src/ai/client.js';
import { runAgentTurn } from '../src/ai/agent.js';
import type { AgentEnv } from '../src/ai/agentTools.js';
import { createTask, approveTask, listDraftTasks } from '../src/core/service.js';
import { resetDb } from './testdb.js';
import { runScript } from './run.js';

const GROUP = -100;

function env(userId: number, isManager: boolean): AgentEnv {
  return {
    userId,
    roomChatId: null, // keep drafts room-less so no rooms row is needed to seed
    locale: 'en',
    isManager,
    isGroup: true,
    reply: async (text: string) => {
      console.log(`   🤖 ${text.replace(/\n/g, '\n      ')}`);
    },
  };
}

async function turn(label: string, userId: number, isManager: boolean, text: string): Promise<void> {
  console.log(`\n── ${label}`);
  console.log(`   👤 ${text}`);
  await runAgentTurn(GROUP, text, env(userId, isManager));
}

async function main(): Promise<void> {
  if (!aiEnabled()) {
    console.error('AI disabled — set NEAR_AI_API_KEY in .env.');
    process.exit(1);
  }
  await resetDb();
  const draft = await createTask({
    title: 'Design a launch banner for the v2 vault',
    description: 'A 1500x500 Twitter header announcing the v2 vault launch.',
    createdBy: 1,
    roomChatId: null,
  });
  await approveTask(draft.id, 1);
  console.log(`Agent model: ${config.agentModel}\nSeeded open task #${draft.id}.`);

  const before = (await listDraftTasks()).length;

  // 1) Contributor browses — expect a list_open_tasks call and a readable answer.
  await turn('contributor: browse open tasks', 2, false, 'hey, what tasks are open right now?');

  // 2) Contributor drills in — expect get_task.
  await turn('contributor: task detail', 2, false, `tell me more about task ${draft.id}`);

  // 3) Non-admin tries to create — the tool must refuse (propose-don't-perform + auth).
  await turn('contributor: tries to create (should be refused)', 2, false, 'create a task to write our newsletter');

  // 4) Admin, multi-turn clarify: a vague ask should draw a question, not a draft…
  await turn('admin: vague draft request', 1, true, 'can you draft a task for me?');
  // …and the follow-up (same user → same memory) should let it draft.
  await turn('admin: answers the question', 1, true, 'write the v2 launch blog post, ~800 words, done when the draft is in the shared doc, one person, by Friday');

  const after = (await listDraftTasks()).length;
  console.log(`\nDraft tasks created by the agent this run: ${after - before} (expect ≥1, all Draft — never Open).`);
  if (after - before < 1) {
    // Hard-fail, not a printed shrug: this smoke exists to catch live-model
    // drift, and "the agent re-asks instead of drafting once it has the three
    // essentials" is exactly the drift it once let pass silently (2026-07-14).
    console.error('❌ the agent created no draft from a fully-specified request — prompt drift.');
    process.exit(1);
  }
}

runScript(main);
