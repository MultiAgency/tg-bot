import { config } from '../config.js';
import * as ai from '../ai/assist.js';
import { claimSignalSlot, discardSignal, draftTaskFromSignal, getRoom } from '../core/service.js';
import { notifySignalDraft } from './notify.js';

/**
 * Signal detection: group-chat messages in rooms that opted in (/enablesignals)
 * are scored by AI, and promising ones become DRAFT tasks for human approval.
 * Privacy invariants (see /privacy and SCOPE.md): the message text goes to the
 * model and is then dropped — never stored — and neither is the author's id; a
 * signal row records only room, score, and outcome. AI stays advisory: the
 * strongest signal only ever creates a Draft — a human approves it (or not).
 */

// Cheap heuristics to skip obvious noise before spending a rate-limit slot
// and an API call.
const MIN_LENGTH = 15;
const MIN_WORDS = 3;

export function passesPreFilter(text: string): boolean {
  if (text.length < MIN_LENGTH) return false;
  return text.split(/\s+/).filter(Boolean).length >= MIN_WORDS;
}

/**
 * Process one group message. The caller runs this detached (via runDetached) so
 * it never holds the author's serialized update queue for the AI timeout — group
 * members are not bot users and must never feel its latency — while keeping the
 * whole handler, budget claim and all, in the shutdown drain set. `signal` aborts
 * the model call on shutdown, so a redeploy caught mid-evaluation unwinds at once
 * and discards the claimed slot cleanly. A slot is left 'evaluating' only by an
 * unclean death (SIGKILL/crash); reclaimStaleSignals clears those at the next
 * boot. Either way it still counted against its hour's budget, the conservative
 * failure mode.
 */
export async function handleGroupMessage(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
  // Free gates first: AI off bot-wide or obvious noise kills most group
  // traffic without paying the per-message DB round trip below.
  if (!ai.aiEnabled() || !passesPreFilter(text)) return;
  const room = await getRoom(chatId);
  if (!room || !room.signals_enabled) return;
  const signalId = await claimSignalSlot(chatId, config.signalMaxPerHour);
  if (signalId === null) return; // hourly AI budget for this room is spent
  await evaluate(signalId, chatId, text, signal);
}

async function evaluate(signalId: number, chatId: number, text: string, signal?: AbortSignal): Promise<void> {
  const evaluation = await ai.evaluateSignal(text, signal);
  if (
    !evaluation ||
    !evaluation.shouldDraft ||
    evaluation.score < config.signalScoreThreshold ||
    evaluation.title === null ||
    evaluation.description === null
  ) {
    await discardSignal(signalId, evaluation?.score ?? null);
    return;
  }
  // draftTaskFromSignal returns the room title read in its own transaction, so
  // the alert names the current group name even if it was retitled mid-evaluation.
  const { task, roomTitle } = await draftTaskFromSignal(
    signalId,
    chatId,
    { title: evaluation.title, description: evaluation.description, requiredOutput: evaluation.requiredOutput },
    evaluation.score,
  );
  console.log(`[signals] drafted task #${task.id} from a signal in room ${chatId} (score ${evaluation.score})`);
  await notifySignalDraft(task, roomTitle);
}
