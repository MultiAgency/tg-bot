import OpenAI, { type ClientOptions } from 'openai';
import { config } from '../config.js';
import type { Task } from '../core/models/task.js';

/**
 * Lightweight AI assistance, powered by NEAR AI Cloud (an OpenAI-compatible
 * inference API). Every helper degrades gracefully: if no API key is configured,
 * or the call fails, it returns null and the bot carries on without AI.
 * The human always makes the final decision — AI only drafts and summarizes.
 */

const client = config.nearAiApiKey
  ? new OpenAI({
      apiKey: config.nearAiApiKey,
      baseURL: config.nearAiBaseUrl,
      // These calls run inside a wizard step, which is serialized per user — a
      // hung request would otherwise block that user's queue for minutes.
      timeout: 30_000,
      maxRetries: 1,
      // Late-bound platform fetch (the SDK otherwise captures its own bundled
      // one): identical in production (Node's built-in fetch), and it lets the
      // demo suites stub this network boundary the way they stub Telegram's.
      // Cast: the SDK's option is typed against node-fetch, but any
      // fetch-compatible function (Node's built-in included) is accepted.
      fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
        globalThis.fetch(...args)) as unknown as ClientOptions['fetch'],
    })
  : null;

export function aiEnabled(): boolean {
  return client !== null;
}

async function complete(
  kind: string,
  system: string,
  user: string,
  maxTokens = 700,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!client) return null;
  try {
    const response = await client.chat.completions.create(
      {
        model: config.aiModel,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      { signal },
    );
    const text = response.choices[0]?.message?.content?.trim();
    // One greppable line per served draft — the pilot-exit signal for whether
    // AI assistance earns its keep. Deliberately a log, not a DB column: usage
    // telemetry is an operational signal, not a business fact.
    if (text) console.log(`[ai] ${kind} served (${text.length} chars)`);
    return text || null;
  } catch (err) {
    // A shutdown abort is a clean interruption, not a failure: return null
    // quietly so the detached caller discards its unfinished work, with no
    // error line on every graceful restart.
    if (signal?.aborted) return null;
    console.error(`[ai] ${kind} request failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Draft a clear task description from a short prompt. */
export function suggestTaskDescription(prompt: string, signal?: AbortSignal): Promise<string | null> {
  return complete(
    'description',
    'You help a community coordinator write clear, concise task briefs for contributors. ' +
      'Return only the task description as 2–4 short sentences. No headings, no preamble.',
    `Write a task description for: ${prompt}`,
    700,
    signal,
  );
}

/** Suggest a concrete "required output" spec for a task. */
export function suggestRequiredOutput(title: string, description: string, signal?: AbortSignal): Promise<string | null> {
  return complete(
    'required-output',
    'You define acceptance criteria for contributor tasks. Return only a short, concrete ' +
      'description of the required deliverable (1–2 sentences or a short bullet list). No preamble.',
    `Task title: ${title}\nDescription: ${description}\n\nWhat should the contributor deliver?`,
    700,
    signal,
  );
}

export interface SignalEvaluation {
  /** 0–10; the caller compares it to config.signalScoreThreshold. */
  score: number;
  /** The model's own draft/skip call — both gates must agree to draft. */
  shouldDraft: boolean;
  title: string | null;
  description: string | null;
  requiredOutput: string | null;
}

/**
 * Extract the first complete brace-balanced JSON object from a model reply,
 * ignoring braces inside strings. Scanning to the matching close (rather than
 * lastIndexOf('}')) means trailing prose that itself contains a '}' — e.g. a
 * "(confidence: high :})" aside after the object — can't extend the slice past
 * the real object and break the parse. Returns null if no balanced object is found.
 */
function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

/**
 * Parse the model's JSON reply, tolerating the usual failure shapes (markdown
 * fences, prose around the object) and returning null for anything that doesn't
 * validate — a bad response means "not a signal", never a crash or a bad task.
 */
function parseSignalEvaluation(raw: string): SignalEvaluation | null {
  const json = firstJsonObject(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.score !== 'number' || !Number.isFinite(p.score)) return null;
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    score: Math.min(10, Math.max(0, p.score)),
    shouldDraft: p.shouldDraft === true,
    title: text(p.title),
    description: text(p.description),
    requiredOutput: text(p.requiredOutput),
  };
}

/**
 * Score one group-chat message as a potential task (signal detection). Returns
 * null when AI is off, the call fails, or the reply doesn't validate. Advisory
 * like everything here: a positive evaluation only ever creates a DRAFT task —
 * a human still approves it before anyone can apply.
 */
export async function evaluateSignal(message: string, signal?: AbortSignal): Promise<SignalEvaluation | null> {
  const raw = await complete(
    'signal',
    'You are the signal-detection layer of a contributor-coordination bot watching a community ' +
      'group chat. Decide whether the message describes concrete work a contributor could be ' +
      'recruited for (a request, an event needing help, a content opportunity, a community ask). ' +
      'Score it 0-10 for importance, timeliness, and actionability. Set shouldDraft to true only ' +
      `if the score is ${config.signalScoreThreshold} or higher AND the message contains enough information to draft a task ` +
      'someone could act on. Respond with ONLY valid JSON, no prose, no markdown fences, exactly: ' +
      '{"score": number, "shouldDraft": boolean, "title": string|null, "description": string|null, ' +
      '"requiredOutput": string|null}',
    `Message:\n${message}`,
    500,
    signal,
  );
  return raw ? parseSignalEvaluation(raw) : null;
}

/**
 * One advisory note per submission for the reviewer: a short summary plus any
 * required-output items that appear to be missing. Deliberately observations,
 * never a completeness verdict — a "looks complete" judgment would anchor the
 * human decision it is meant to inform.
 */
export function reviewNote(task: Task, submission: string, signal?: AbortSignal): Promise<string | null> {
  return complete(
    'review-note',
    'You help a busy reviewer assess a contributor submission. Return two parts: ' +
      '(1) 1–3 sentences summarizing what was submitted and anything notable; ' +
      '(2) if any part of the required output appears to be missing, one sentence starting ' +
      '"Possibly missing:" naming it — omit this part when nothing seems missing. ' +
      'Point at facts only; give no overall completeness verdict. The human decides. No preamble.',
    `Task: ${task.title}\nRequired output: ${task.required_output ?? '(unspecified)'}\n\n` +
      `Submission:\n${submission}`,
    700,
    signal,
  );
}
