import type OpenAI from 'openai';
import { Markup } from 'telegraf';
import { config } from '../config.js';
import {
  createTask,
  getTask,
  isTaskPublic,
  listOpenTasksWithSlots,
  countSlotsTaken,
  countPendingApplications,
  getApplicationFor,
  applicationsWithContext,
  applyRefusal,
} from '../core/service.js';
import { clampSlots } from './assist.js';
import type { Task } from '../core/models/task.js';
import { taskDetail } from '../bot/format.js';
import { approveButton, applyAffordanceBtn } from '../bot/keyboards.js';

/**
 * Tools for the conversational agent (group /ai mode). The design rule mirrors
 * the rest of the bot: the agent PROPOSES, humans decide. Read tools return
 * data; state-changing tools only ever render a confirmation card carrying the
 * SAME buttons the classic commands use (approve:<id>, apply:<id>) — the actual
 * mutation happens when a human taps, going through the identical auth + atomic
 * guards. The agent can therefore never silently create, open, or apply.
 */

/** What the executor needs from the surrounding chat, minus Telegram specifics. */
export interface AgentEnv {
  /** The requesting user — recorded as a draft's author (they initiated it). */
  userId: number;
  /** The room this conversation belongs to (drafts inherit it), or null in DM. */
  roomChatId: number | null;
  locale: string;
  /** Global admin or admin of this room — gates create_task_draft. */
  isManager: boolean;
  isGroup: boolean;
  /** Send a message (optionally a card) into the conversation's chat. */
  reply: (text: string, extra?: unknown) => Promise<void>;
}

export const AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_open_tasks',
      description:
        'List open tasks. Each includes assigned/slots and a "full" flag — a full task is open in status ' +
        'but has no free slots, so it is NOT applyable; say so rather than inviting an application.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task',
      description: 'Full details for one task by its id (title, status, reward, deadline, required output, assignees).',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'integer' } },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_my_applications',
      description: "List the requesting user's own applications and their status.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task_draft',
      description:
        'Draft a new task (admins only). Shows the admin an Approve card — it does NOT open the task or notify anyone. ' +
        'Ask the admin for any missing essential (a clear title, what is needed, the acceptance criteria) before calling. ' +
        'Do not invent a reward; omit it unless the admin stated one.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string', description: "What's needed and why it matters now." },
          requiredOutput: { type: 'string', description: 'Definition of done — a concrete, testable checklist.' },
          reward: { type: 'string', description: 'Only if the admin stated one; otherwise omit.' },
          deadline: { type: 'string' },
          maxAssignees: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['title', 'description'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_apply',
      description:
        'Show an Apply card for a task the user can actually apply to. Returns an error (relay it, do not show a card) ' +
        'if the task is not open, is fully assigned, or the user already has an application for it. Does NOT apply by itself.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'integer' } },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
  },
];

type ToolResult = Record<string, unknown>;

function brief(task: { id: number; title: string; status: string; reward: string | null; deadline: string | null }): ToolResult {
  return { id: task.id, title: task.title, status: task.status, reward: task.reward, deadline: task.deadline };
}

/**
 * Visibility gate for every by-id task tool (get_task, propose_apply): the
 * service floor (isTaskPublic — a draft never leaves the service) widened for a
 * manager of the room the task belongs to. Callers answer hidden and missing
 * ids with the SAME "not found (or not visible here)" — any distinguishable
 * reply (even a refusal like "not open") would be an existence oracle a
 * contributor could probe hidden draft ids against.
 */
function visibleTask(env: AgentEnv, task: Task | undefined): task is Task {
  return task !== undefined && (isTaskPublic(task) || (env.isManager && task.room_chat_id === env.roomChatId));
}

/**
 * Run one tool the model asked for. Returns a plain object fed back to the model
 * as the tool result; any card meant for the human is sent via env.reply as a
 * side effect. Never throws to the loop — a failed tool returns an { error }
 * the model can read and explain.
 */
export async function executeAgentTool(env: AgentEnv, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  // Honor the "never throws" contract for real: a thrown tool (transient DB
  // error, a value the DB rejects) would leave the assistant tool_calls message
  // in the turn with no matching result and brick the conversation. Any failure
  // becomes an { error } the model reads and explains.
  try {
    return await runTool(env, name, input);
  } catch (err) {
    console.error(`[agent] tool ${name} failed:`, err instanceof Error ? err.message : err);
    return { error: 'That action could not be completed right now.' };
  }
}

async function runTool(env: AgentEnv, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'list_open_tasks': {
      // Slot-annotated (the shared open-board read) so the agent can tell an
      // applyable task from one that's open-but-full — the same distinction
      // /open draws when it labels a task "Fully assigned".
      const rows = await listOpenTasksWithSlots();
      return {
        tasks: rows.map(({ task, assigned }) => ({
          ...brief(task),
          assigned,
          slots: task.max_assignees,
          full: assigned >= task.max_assignees,
        })),
      };
    }

    case 'get_task': {
      const task = await getTask(Number(input.taskId));
      if (!visibleTask(env, task)) return { error: `Task #${input.taskId} not found (or not visible here).` };
      const assigned = await countSlotsTaken(task.id);
      return { task: { ...brief(task), description: task.description, requiredOutput: task.required_output, assigned, slots: task.max_assignees } };
    }

    case 'list_my_applications': {
      const rows = await applicationsWithContext(env.userId);
      return {
        applications: rows.map(({ application, task }) => ({
          taskId: application.task_id,
          title: task?.title ?? `#${application.task_id}`,
          status: application.status,
        })),
      };
    }

    case 'create_task_draft': {
      if (!env.isManager) return { error: 'Only room or global admins can create tasks here.' };
      const title = String(input.title ?? '').trim();
      const description = String(input.description ?? '').trim();
      if (!title || !description) return { error: 'A draft needs at least a title and a description.' };
      // clampSlots guards the unusable ("a few" → NaN would slip through
      // createTask's `?? 1` into the integer column); undefined → default of 1.
      const maxAssignees = clampSlots(input.maxAssignees) ?? undefined;
      const task = await createTask({
        title,
        description,
        requiredOutput: input.requiredOutput ? String(input.requiredOutput) : null,
        reward: input.reward ? String(input.reward) : null,
        deadline: input.deadline ? String(input.deadline) : null,
        maxAssignees,
        createdBy: env.userId,
        roomChatId: env.roomChatId,
      });
      await env.reply(taskDetail(task, 0), approveButton(task, env.locale));
      return { result: `Drafted task #${task.id}; an Approve card was shown. The admin must tap Approve to open it.` };
    }

    case 'propose_apply': {
      const task = await getTask(Number(input.taskId));
      if (!visibleTask(env, task)) return { error: `Task #${input.taskId} not found (or not visible here).` };
      // Evaluate the SAME guard chain service.apply enforces (applyRefusal), so
      // the agent never dangles an Apply button the apply flow would just refuse
      // — and the two can't drift. Advisory unlocked reads; the mutator re-checks
      // everything under row locks when the human taps.
      const [assigned, existing, pending] = await Promise.all([
        countSlotsTaken(task.id),
        getApplicationFor(task.id, env.userId),
        countPendingApplications(env.userId),
      ]);
      const refusal = applyRefusal(task, assigned, existing, pending);
      if (refusal) return { error: refusal };
      // Same placement rule as the /open paginator (applyAffordanceBtn): a card
      // with no button in a group with no known @username, never a dead-end tap.
      const btn = applyAffordanceBtn(task, !env.isGroup, config.botUsername, env.locale);
      await env.reply(taskDetail(task, assigned), btn ? Markup.inlineKeyboard([btn]) : undefined);
      return { result: `Shown an Apply card for task #${task.id}.` };
    }

    default:
      return { error: `Unknown tool "${name}".` };
  }
}
