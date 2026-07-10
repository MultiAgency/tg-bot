import OpenAI from 'openai';
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
    })
  : null;

export function aiEnabled(): boolean {
  return client !== null;
}

async function complete(kind: string, system: string, user: string, maxTokens = 700): Promise<string | null> {
  if (!client) return null;
  try {
    const response = await client.chat.completions.create({
      model: config.aiModel,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const text = response.choices[0]?.message?.content?.trim();
    // One greppable line per served draft — the pilot-exit signal for whether
    // AI assistance earns its keep. Deliberately a log, not a DB column: usage
    // telemetry is an operational signal, not a business fact.
    if (text) console.log(`[ai] ${kind} served (${text.length} chars)`);
    return text || null;
  } catch (err) {
    console.error(`[ai] ${kind} request failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Draft a clear task description from a short prompt. */
export function suggestTaskDescription(prompt: string): Promise<string | null> {
  return complete(
    'description',
    'You help a community coordinator write clear, concise task briefs for contributors. ' +
      'Return only the task description as 2–4 short sentences. No headings, no preamble.',
    `Write a task description for: ${prompt}`,
  );
}

/** Suggest a concrete "required output" spec for a task. */
export function suggestRequiredOutput(title: string, description: string): Promise<string | null> {
  return complete(
    'required-output',
    'You define acceptance criteria for contributor tasks. Return only a short, concrete ' +
      'description of the required deliverable (1–2 sentences or a short bullet list). No preamble.',
    `Task title: ${title}\nDescription: ${description}\n\nWhat should the contributor deliver?`,
  );
}

/**
 * One advisory note per submission for the reviewer: a short summary plus any
 * required-output items that appear to be missing. Deliberately observations,
 * never a completeness verdict — a "looks complete" judgment would anchor the
 * human decision it is meant to inform.
 */
export function reviewNote(task: Task, submission: string): Promise<string | null> {
  return complete(
    'review-note',
    'You help a busy reviewer assess a contributor submission. Return two parts: ' +
      '(1) 1–3 sentences summarizing what was submitted and anything notable; ' +
      '(2) if any part of the required output appears to be missing, one sentence starting ' +
      '"Possibly missing:" naming it — omit this part when nothing seems missing. ' +
      'Point at facts only; give no overall completeness verdict. The human decides. No preamble.',
    `Task: ${task.title}\nRequired output: ${task.required_output ?? '(unspecified)'}\n\n` +
      `Submission:\n${submission}`,
  );
}
