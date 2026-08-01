import { config } from '../config.js';
import { client } from './client.js';
import type { Task } from '../core/models/task.js';

/**
 * Lightweight AI assistance, powered by NEAR AI Cloud (an OpenAI-compatible
 * inference API). Every helper degrades gracefully: if no API key is configured,
 * or the call fails, it returns null and the bot carries on without AI.
 * The human always makes the final decision — AI only drafts and summarizes.
 */

export { aiEnabled } from './client.js';

export const AI_ASSIST_PROMPT_VERSION = '2026-08-01.ai-assist-v2';

export interface AiAssessmentMetadata {
  provider: 'near-ai-openai-compatible';
  model: string;
  promptVersion: string;
  parsed: boolean;
  confidence: number | null;
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

// ---------------------------------------------------------------------------
// House style — how a drafted task brief should read.
//
// Deliberately small: the model's only output is a task brief (title,
// description, deadline, slots, definition of done), so this steers exactly
// that and nothing more. The source bot's fuller brand voice / strategy /
// visual-concept library was for a content-drafting agent (captions, threads,
// videos) this bot doesn't have — no field here consumes it, so it's omitted
// rather than paid for on every signal call.
// ---------------------------------------------------------------------------

const STYLE = `You draft internal task briefs for contributors in a community-coordination bot.
Write plainly and concretely — no hype, no emoji, no crypto-Twitter clichés
("alpha", "bullish", "this changes everything", and the like). Say what the work
is and why it matters now; skip filler and manufactured urgency. Contributors
keep their own IP. You only draft — a human approves, edits, or discards every
draft before it reaches anyone.`;

// The structured shape a drafted task must take. Field names match the columns
// on tasks/NewTaskInput so an approved draft routes with no translation. No
// reward field: an AI-invented amount is a real expectation a contributor would
// see, and only a human knows the actual budget source — so reward stays null
// and is set at approval. (Also no role/refs/specs/assets: no such columns —
// fold any format, reference, or asset notes into the description instead.)
const DRAFT_CONTRACT = `Draft the task as a JSON object with these fields:
  "title":          short, concrete headline (<= 80 chars)
  "description":    2-4 sentences: what's needed and why it matters now
  "deadline":       the turnaround the message states, in its own terms, e.g. "within 48h" or
                    "before Friday's call" — you have no calendar, so never invent a specific date
                    or clock time the message didn't give; null if none is stated
  "maxAssignees":   integer 1-20, how many contributors should take this (usually 1-3), or null for 1
  "requiredOutput": the definition of done — a flat, testable acceptance checklist,
                    one item per line as "- ...", specific enough to review a submission against, or null
Do not suggest a reward — a human sets that at approval.`;

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

/**
 * Clamp a model-emitted assignee count to the AI drafting cap of 1–20 — never
 * trust the model with a routing-critical number. Deliberately tighter than the
 * human ceiling (workflow MAX_ASSIGNEES): an AI draft calling for dozens of
 * contributors is noise a human can still raise at approval. Anything
 * non-numeric ("a few", null, absent) becomes null; callers map null to
 * createTask's default of 1. Shared by both AI drafting paths (signal
 * evaluation here, the agent's create_task_draft).
 */
export function clampSlots(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.round(n))) : null;
}

export interface SignalEvaluation {
  /** 0–10; the caller compares it to config.signalScoreThreshold. */
  score: number;
  /** The model's own draft/skip call — both gates must agree to draft. */
  shouldDraft: boolean;
  title: string | null;
  description: string | null;
  requiredOutput: string | null;
  /** Suggested turnaround; null when the model offers none. */
  deadline: string | null;
  /** Clamped to 1–20; null falls back to the createTask default of 1. */
  maxAssignees: number | null;
  /** Short explanation for the admin; must not quote group text verbatim. */
  reason: string | null;
  /** 0–1 confidence in this signal assessment. */
  confidence: number | null;
}

interface RequirementCheck {
  requirement: string;
  status: 'met' | 'unclear' | 'missing';
  evidence: string | null;
}

interface ReviewAssessment {
  summary: string;
  requirementChecks: RequirementCheck[];
  missingItems: string[];
  risks: string[];
  questions: string[];
  confidence: number;
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
export function parseSignalEvaluation(raw: string): SignalEvaluation | null {
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
    deadline: text(p.deadline),
    maxAssignees: clampSlots(p.maxAssignees),
    reason: text(p.reason),
    confidence:
      typeof p.confidence === 'number' && Number.isFinite(p.confidence)
        ? Math.min(1, Math.max(0, p.confidence))
        : null,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const json = firstJsonObject(raw);
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function textList(v: unknown, limit = 5): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(text).filter((item): item is string => item !== null).slice(0, limit);
}

export function parseReviewAssessment(raw: string): ReviewAssessment | null {
  const p = parseJsonObject(raw);
  if (p === null) return null;
  const summary = text(p.summary);
  if (summary === null) return null;

  const checks = Array.isArray(p.requirementChecks)
    ? p.requirementChecks
        .map((item): RequirementCheck | null => {
          if (typeof item !== 'object' || item === null) return null;
          const row = item as Record<string, unknown>;
          const requirement = text(row.requirement);
          const status = row.status;
          if (requirement === null || (status !== 'met' && status !== 'unclear' && status !== 'missing')) return null;
          return { requirement, status, evidence: text(row.evidence) };
        })
        .filter((item): item is RequirementCheck => item !== null)
        .slice(0, 6)
    : [];

  const confidence =
    typeof p.confidence === 'number' && Number.isFinite(p.confidence)
      ? Math.min(1, Math.max(0, p.confidence))
      : 0.5;
  return {
    summary,
    requirementChecks: checks,
    missingItems: textList(p.missingItems),
    risks: textList(p.risks),
    questions: textList(p.questions, 3),
    confidence,
  };
}

function renderReviewAssessment(a: ReviewAssessment): string {
  const lines = [
    `Summary: ${a.summary}`,
  ];
  if (a.requirementChecks.length) {
    lines.push(
      '',
      'Requirement check:',
      ...a.requirementChecks.map((c) => {
        const evidence = c.evidence ? ` — ${c.evidence}` : '';
        return `- ${c.status}: ${c.requirement}${evidence}`;
      }),
    );
  }
  if (a.missingItems.length) lines.push('', `Possibly missing: ${a.missingItems.join('; ')}`);
  if (a.risks.length) lines.push('', `Risks: ${a.risks.join('; ')}`);
  if (a.questions.length) lines.push('', 'Reviewer questions:', ...a.questions.map((q) => `- ${q}`));
  lines.push('', `Confidence: ${Math.round(a.confidence * 100)}%`);
  return lines.join('\n');
}

/**
 * Score one group-chat message as a potential task (signal detection). Returns
 * null when AI is off, the call fails, or the reply doesn't validate. Advisory
 * like everything here: a positive evaluation only ever creates a DRAFT task —
 * a human still approves it before anyone can apply.
 */
export async function evaluateSignal(
  message: string,
  context: string[] = [],
  signal?: AbortSignal,
): Promise<SignalEvaluation | null> {
  // Prior room chatter, clearly fenced off from the message under assessment so
  // the model scores the right thing but can borrow a deadline or scope that was
  // mentioned a few lines earlier.
  const contextBlock = context.length
    ? 'Recent room chatter, oldest first — context only, NOT the message to assess:\n' +
      context.map((c) => `- ${c}`).join('\n') +
      '\n\n'
    : '';
  const raw = await complete(
    'signal',
    `${STYLE}\n\n` +
      'You are the signal-detection layer watching the community group chat. Most chatter is not ' +
      'a task — ignore banter, questions, and vague ideas. Decide whether the message is a clear, ' +
      'concrete signal that work should be commissioned: a builder shipped something worth ' +
      'amplifying, a launch or milestone was announced, an event needs help, or someone explicitly ' +
      'asks for work to be done. You may use the recent room chatter to fill in a draft, but score ' +
      'only the message under assessment. Score it 0-10 for importance, timeliness, and ' +
      `actionability. Set shouldDraft to true only if the score is ${config.signalScoreThreshold} or higher AND there is ` +
      'enough information (in the message or the context) to draft to standard. When it clears the ' +
      'bar, draft the task to the contract below.\n\n' +
      `${DRAFT_CONTRACT}\n\n` +
      'Respond with ONLY valid JSON, no prose, no markdown fences, exactly: ' +
      '{"score": number, "shouldDraft": boolean, "title": string|null, "description": string|null, ' +
      '"requiredOutput": string|null, "deadline": string|null, "maxAssignees": number|null, ' +
      '"reason": string|null, "confidence": number|null}. ' +
      'Reason is a one-sentence admin-facing explanation of why this should become a task; summarize, never quote ' +
      'the group message verbatim. Confidence is 0-1 for this assessment. ' +
      'Be conservative — when in doubt, shouldDraft is false and the draft fields are null.',
    `${contextBlock}Message to assess:\n${message}`,
    700,
    signal,
  );
  return raw ? parseSignalEvaluation(raw) : null;
}

/**
 * One advisory note per submission for the reviewer: a structured rubric pass
 * over the required output plus risks and questions. Deliberately observations,
 * never a completeness verdict — a "looks complete" judgment would anchor the
 * human decision it is meant to inform.
 */
export async function reviewNote(task: Task, submission: string, signal?: AbortSignal): Promise<string | null> {
  return (await reviewNoteWithMetadata(task, submission, signal))?.text ?? null;
}

export interface AiReviewNote {
  text: string;
  metadata: AiAssessmentMetadata;
}

export async function reviewNoteWithMetadata(
  task: Task,
  submission: string,
  signal?: AbortSignal,
): Promise<AiReviewNote | null> {
  const raw = await complete(
    'review-note',
    'You help a busy reviewer assess a contributor submission. Point at facts only; never give an overall ' +
      'approve/reject verdict and never claim work is complete. Compare the submission against each required-output ' +
      'item when the task provides one. Respond with ONLY valid JSON, no prose, no markdown fences, exactly: ' +
      '{"summary": string, "requirementChecks": [{"requirement": string, "status": "met"|"unclear"|"missing", ' +
      '"evidence": string|null}], "missingItems": string[], "risks": string[], "questions": string[], ' +
      '"confidence": number}. Confidence is 0-1 and means confidence in this assessment, not quality of the work. ' +
      'Use "unclear" when the submission does not give enough evidence. Keep every string concise.',
    `Task: ${task.title}\nRequired output: ${task.required_output ?? '(unspecified)'}\n\n` +
      `Submission:\n${submission}`,
    900,
    signal,
  );
  if (raw === null) return null;
  const assessment = parseReviewAssessment(raw);
  const metadata: AiAssessmentMetadata = {
    provider: 'near-ai-openai-compatible',
    model: config.aiModel,
    promptVersion: AI_ASSIST_PROMPT_VERSION,
    parsed: assessment !== null,
    confidence: assessment?.confidence ?? null,
  };
  return {
    text: assessment ? renderReviewAssessment(assessment) : raw,
    metadata,
  };
}
