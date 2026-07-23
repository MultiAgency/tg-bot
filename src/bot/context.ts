import { Markup, type Scenes } from 'telegraf';
import { config } from '../config.js';
import { t, localeOf } from './i18n.js';

/** Per-wizard scratch state, accumulated across steps and cleared on scene leave. */
interface WizardState {
  // new-task wizard
  title?: string;
  description?: string;
  reward?: string;
  deadline?: string;
  requiredOutput?: string;
  maxAssignees?: number;
  // apply wizard
  taskId?: number;
  // submit & unassign wizards
  applicationId?: number;
  // submit wizard: album already refused with a reply (one warning per album)
  warnedMediaGroupId?: string;
  // review-note wizard
  submissionId?: number;
  decision?: 'reject' | 'revise';
}

export type BotContext = Scenes.WizardContext;

export const SCENES = {
  newTask: 'new-task',
  apply: 'apply',
  submit: 'submit-work',
  review: 'review-note',
  unassign: 'unassign-reason',
} as const;

/** Read trimmed text from the current message, or null if this update carries no text. */
export function messageText(ctx: BotContext): string | null {
  const msg = ctx.message;
  if (msg && 'text' in msg && typeof msg.text === 'string') {
    return msg.text.trim();
  }
  return null;
}

/** Match "/name" and the group-chat form "/name@BotUsername" (case-insensitive). */
export function isCommand(text: string | null, name: string): boolean {
  if (!text) return false;
  return new RegExp(`^/${name}(@\\w+)?$`, 'i').test(text);
}

function looksLikeCommand(text: string | null): boolean {
  return text !== null && text.startsWith('/');
}

/** The first argument after a command, e.g. "12" from "/status 12" — or undefined. */
export function commandArg(ctx: BotContext): string | undefined {
  return (messageText(ctx) ?? '').split(/\s+/)[1];
}

/** Parse a task id argument: a plain positive integer, or null for anything else. */
export function parseId(raw: string | undefined): number | null {
  // Require all-digits so "1e5", "0x10", " 12 " etc. don't coerce to a surprise id.
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/**
 * Shared wizard-step guard. Handles the cases every scene must survive:
 *  - a button tap while the wizard is active (answer it so it doesn't spin,
 *    and tell the user to finish or /cancel first);
 *  - /cancel (with or without @BotName) → leave the scene;
 *  - any other command → refuse to swallow it as content.
 * Returns true if the update was consumed and the step should stop.
 */
export async function handledWizardInterrupt(
  ctx: BotContext,
  text: string | null,
  opts: { allowAi?: boolean } = {},
): Promise<boolean> {
  const L = localeOf(ctx);
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(t(L, 'wizard.buttonBusy'), { show_alert: true }).catch(() => undefined);
    return true;
  }
  if (isCommand(text, 'cancel')) {
    // removeKeyboard, like the scenes' own exits: a wizard step may have posted
    // a one-time reply keyboard ("⏭ Apply without a pitch"); left in place, its
    // tap after the scene died sends literal text that gets no answer.
    await ctx.reply(t(L, 'common.cancelled'), Markup.removeKeyboard());
    await ctx.scene.leave();
    return true;
  }
  // /ai is the one command a step may let through (the AI-drafting wizard steps).
  if (looksLikeCommand(text) && !(opts.allowAi && isCommand(text, 'ai'))) {
    await ctx.reply(t(L, 'wizard.commandsPaused'));
    return true;
  }
  return false;
}

/**
 * `answerCbQuery` that never throws. A stale/expired callback query — common when
 * Telegram redelivers a backlog after a restart, by which time a query drained
 * through `perUserQueue` + DB reads can exceed the answer window — rejects with
 * 400 "query is too old". Left unhandled that aborts the handler (fatally so
 * before a `scene.enter`, where the wizard would then silently never start) or
 * surfaces as an unhandled rejection. The popup is best-effort; swallow the error
 * so the handler's real work still runs.
 */
export function safeAnswerCb(
  ctx: BotContext,
  text?: string,
  extra?: Parameters<BotContext['answerCbQuery']>[1],
): Promise<unknown> {
  return ctx.answerCbQuery(text, extra).catch(() => undefined);
}

/** Typed view of the wizard's scratch state. Scene-enter params land here too — scene state IS the wizard state. */
export function wizardState(ctx: BotContext): WizardState {
  return ctx.wizard.state as WizardState;
}

/**
 * The final step of a wizard: run the mutation, reply, LEAVE — on every path.
 * A throw must still reply and leave, or the admin is silently stranded in the
 * wizard (their next command eaten until they guess /cancel); and once the
 * mutation committed, a failed confirmation send (429 window) must still leave —
 * staying invites a "retry" that duplicates the committed work. Both replies
 * are best-effort for exactly those reasons.
 */
export async function finishScene<T>(
  ctx: BotContext,
  mutate: () => Promise<T>,
  okReply: (result: T) => Promise<unknown>,
  failReply: (err: unknown) => Promise<unknown>,
): Promise<unknown> {
  let result: T;
  try {
    result = await mutate();
  } catch (err) {
    await failReply(err).catch(() => undefined);
    return ctx.scene.leave();
  }
  await okReply(result).catch(() => undefined);
  return ctx.scene.leave();
}

/**
 * The single private-chat gate; `key` picks the redirect message. Three flows
 * need it: wizards (Telegram's default group privacy mode never delivers the
 * free-form text they collect — entered from a group they would prompt and
 * then wait forever on input that can't arrive), admin commands (their
 * replies render contributor PII that must never land in a group), and
 * contributor commands that render the invoker's own applications/profile.
 */
export async function requirePrivateChat(
  ctx: BotContext,
  key: 'wizard.privateOnly' | 'common.adminPrivateOnly' | 'common.privateOnly' = 'wizard.privateOnly',
): Promise<boolean> {
  if (ctx.chat?.type === 'private') return true;
  await ctx.reply(t(localeOf(ctx), key, { username: config.botUsername || null }));
  return false;
}

export function displayName(from: { first_name?: string; last_name?: string } | undefined): string {
  if (!from) return '';
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
}
