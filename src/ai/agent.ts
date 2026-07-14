import type OpenAI from 'openai';
import { config } from '../config.js';
import { client } from './client.js';
import { AGENT_TOOLS, executeAgentTool, type AgentEnv } from './agentTools.js';
import { esc } from '../bot/format.js';

/**
 * The conversational agent behind group /ai mode. When a room turns AI mode on,
 * members talk to the bot in natural language instead of slash commands; this
 * runs a tool-calling loop (see agentTools.ts) to answer and to PROPOSE actions
 * as confirmation cards a human still taps.
 *
 * Multi-turn: a short per-(chat,user) history is kept in memory so the agent can
 * ask a clarifying question and use the answer on the next turn ("what's the
 * deadline?" → the user replies → it drafts). Privacy: that history is RAM-only,
 * bounded, TTL-evicted, and never persisted — the same treatment as the signal
 * context window. Nothing here writes chat text to disk.
 */

const SYSTEM_PROMPT = `You are the assistant for a Telegram contributor-coordination bot, running in "AI mode" \
inside a group where slash commands are replaced by natural conversation. Contributors and admins talk to you \
to browse tasks, apply, and (admins only) draft tasks.

Use the tools to look things up and to propose actions. Every state-changing tool only shows the user a \
confirmation card with real buttons — it never performs the action itself. Never claim you created, opened, or \
applied to anything unless you called the matching tool, and always make clear a human still taps the button \
("I've drafted this as task #4 — tap Approve to open it").

To draft a task you need three essentials: a clear title, what's needed, and the acceptance criteria (definition \
of done). Ask AT MOST ONE short round of questions, and only when one of those three is genuinely missing. For any \
lesser detail (exact links, tone, dimensions), make a reasonable assumption and note it in the draft rather than \
asking again. Once you have the three essentials, call create_task_draft — do not keep asking. Never invent a \
reward amount. Keep replies short and conversational, in the language the user wrote in. If something isn't \
covered by a tool (reviewing a submission, assigning applicants), say so briefly — don't invent a slash command.

Write in PLAIN TEXT only. The chat shows Markdown and HTML characters literally, so never use *, _, #, backticks, \
or angle-bracket tags for formatting — write plain sentences, and use a simple hyphen "-" if you need a list.`;

/** Role line appended per turn so the agent doesn't lead a non-admin down the drafting path. */
function roleLine(isManager: boolean): string {
  return isManager
    ? 'The current user is an ADMIN and may draft tasks.'
    : 'The current user is a CONTRIBUTOR, not an admin: they cannot create tasks. Do not offer to draft one — help them browse or apply, or suggest they ask an admin.';
}

const MAX_TOOL_ROUNDS = 4;
const MAX_TOKENS = 700;

// Conversation memory: RAM-only, bounded, TTL-evicted (see file header).
const TTL_MS = 10 * 60_000;
const MAX_MESSAGES = 24; // recent turns only — bounds tokens and memory
const MAX_CONVOS = 500;

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
interface Convo {
  messages: Msg[];
  expiresAt: number;
}
const convos = new Map<string, Convo>();

function sweepStale(now: number): void {
  for (const [key, c] of convos) if (c.expiresAt <= now) convos.delete(key);
}

/**
 * A COPY of the stored conversation (or []). Returning a copy — not the live
 * array — is what lets two concurrent turns for the same key each build their
 * own working message list instead of interleaving into one another's.
 */
function loadHistory(key: string, now: number): Msg[] {
  const c = convos.get(key);
  if (!c || c.expiresAt <= now) {
    convos.delete(key);
    return [];
  }
  return [...c.messages];
}

function saveHistory(key: string, messages: Msg[], now: number): void {
  // `messages` here are only user/assistant TEXT turns — the intra-turn tool
  // plumbing is never persisted (see runAgentTurn) — so this tail-trim can never
  // split an assistant tool_calls message from its results.
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages;
  // Delete-then-set keeps Map iteration order = least-recently-saved first,
  // making the eviction below LRU.
  convos.delete(key);
  convos.set(key, { messages: trimmed, expiresAt: now + TTL_MS });
  if (convos.size > MAX_CONVOS) {
    sweepStale(now);
    // Still over (everything inside its TTL — e.g. a flood of distinct users):
    // evict the least-recently-active so MAX_CONVOS is a real bound, not
    // advisory. The just-saved key sits at the tail, so it survives.
    for (const oldest of convos.keys()) {
      if (convos.size <= MAX_CONVOS) break;
      convos.delete(oldest);
    }
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Handle one message a user sent while AI mode is on. `chatId` scopes the
 * conversation memory alongside the user id. Returns quietly if AI is disabled.
 */
export async function runAgentTurn(chatId: number, userText: string, env: AgentEnv, signal?: AbortSignal): Promise<void> {
  if (!client) return;
  const now = Date.now();
  const key = `${chatId}:${env.userId}`;
  // `prior` is a COPY of the persisted user/assistant TEXT exchange; `working`
  // adds this turn's messages — including intra-turn tool_calls / tool results —
  // and is what we send the model. Only a compacted, well-formed slice is
  // persisted (the user turn + the final assistant text), and only on success:
  // a failed or interrupted turn leaves the stored conversation untouched, so it
  // can never brick a room's chat with a dangling tool_calls or orphan result.
  const prior = loadHistory(key, now);
  const userMsg: Msg = { role: 'user', content: userText };
  const working: Msg[] = [...prior, userMsg];
  const commit = (assistantText: string): void =>
    saveHistory(key, [...prior, userMsg, { role: 'assistant', content: assistantText }], now);
  const FALLBACK = "Sorry — I couldn't finish that. Try rephrasing, or ask an admin.";

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await client.chat.completions.create(
        {
          model: config.agentModel,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'system', content: `${SYSTEM_PROMPT}\n\n${roleLine(env.isManager)}` }, ...working],
          tools: AGENT_TOOLS,
        },
        { signal },
      );
      const msg = res.choices[0]?.message;
      if (!msg) break;
      working.push(msg);

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        // Final answer. Always send something — an empty completion still gets an
        // acknowledgement rather than silence — then persist the compacted turn.
        const text = msg.content?.trim() || FALLBACK;
        // Escape the model's free-form text: replies go out under HTML mode, and
        // a '<' or '&' in the answer would otherwise 400 the send. The raw text
        // is what we commit to conversation memory (the model should see its own
        // words, not entities).
        await env.reply(esc(text));
        commit(text);
        console.log(`[agent] turn served (${text.length} chars, ${round} tool round(s))`);
        return;
      }

      // Every tool_calls message must be answered by its matching results in the
      // SAME turn. executeAgentTool never throws (it returns { error }), so the
      // working sequence stays well-formed even when a tool fails.
      for (const call of calls) {
        if (call.type !== 'function') continue;
        const result = await executeAgentTool(env, call.function.name, parseArgs(call.function.arguments));
        working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    // Exhausted the tool-round budget without a final answer.
    await env.reply(FALLBACK);
    commit(FALLBACK);
  } catch (err) {
    if (signal?.aborted) return; // clean shutdown interruption — leave history untouched
    console.error('[agent] turn failed:', err instanceof Error ? err.message : err);
    // Guard the error reply so a send failure here can't surface as an unhandled
    // rejection in the detached task. History is deliberately NOT saved — the
    // prior conversation stays intact and usable on the next turn.
    await env.reply('Something went wrong reaching the assistant — try again in a moment.').catch(() => undefined);
  }
}
