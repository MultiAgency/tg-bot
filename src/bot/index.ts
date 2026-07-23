import { Telegraf, session, Scenes, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import { config, isAdmin } from '../config.js';
import { type BotContext, SCENES, displayName, commandArg, parseId, requirePrivateChat, safeAnswerCb, messageText } from './context.js';
import {
  approveTask,
  discardDraft,
  closeTask,
  reopenTask,
  assignApplication,
  declineApplication,
  withdrawApplication,
  reviewSubmission,
  forgetContributor,
  getTask,
  getApplication,
  listApplicationsByIds,
  listTasksByIds,
  listContributorsByIds,
  latestSubmissionsByApplication,
  countSlotsTaken,
  listOpenTasks,
  listDraftTasks,
  countDraftTasks,
  countOpenTasks,
  countActiveAssignments,
  countStaleAssignments,
  queueAges,
  productStats,
  countSubmittedForReview,
  listApplicantsAwaiting,
  countApplicationsAwaitingPerTask,
  listActiveAssignments,
  applicationsWithContext,
  type ApplicationContext,
  listSubmittedForReview,
  getSubmission,
  getApplicationFor,
  getContributor,
  upsertContributor,
  setAnnounceOptIn,
  notificationCounts,
  listHistory,
  TASK_LEVEL_ACTIONS,
  errorMessage,
  WorkflowError,
  registerRoom,
  migrateRoomChat,
  setRoomSignals,
  setRoomAi,
  addRoomAdmin,
  removeRoomAdmin,
  listRoomAdmins,
  isRoomAdmin,
  canManageTask,
  listRoomsAdministeredBy,
  getRoom,
  signalCountsForRoom,
  isTaskPublic,
  listPayoutsByStatus,
  listPayoutsByContributor,
  listPendingPayoutsForTask,
  reconcilePayout,
  proposalWindow,
  pinnedAmountNear,
  submitRefusal,
  proposePayout,
  getPayoutAccount,
  setPayoutAccount,
  type Payout,
} from '../core/service.js';
import type { Task } from '../core/models/task.js';
import type { Application } from '../core/models/application.js';
import { ApplicationStatus } from '../core/workflow.js';
import { withTransaction } from '../core/db.js';
import { isMediaSubmission, type Submission } from '../core/models/submission.js';
import {
  taskDetail,
  taskShareText,
  applicantCard,
  applicationLine,
  submissionReviewCard,
  activeLine,
  historyBlock,
  contributorProfile,
  clampMessage,
  chunkMessage,
  fullSubmissionText,
  truncate,
  safeSlice,
  field,
  who,
} from './format.js';
import {
  draftButtons,
  applyAffordanceBtn,
  deepLinkApplyButton,
  applicantRow,
  submitButton,
  withdrawButton,
  reviewButtons,
  reviewNextButton,
} from './keyboards.js';
import {
  notifyContributorReview,
  notifyApplicant,
  notifyApplicantsTaskChanged,
  notifyErasureRequest,
  buildAnnounceRows,
  enqueueAnnounceRows,
  sendSubmissionAttachment,
  notifyRoomRegistered,
  notifyRoomAdminPromoted,
  notifyRoomWelcome,
} from './notify.js';
import { handleGroupMessage } from './signals.js';
import { getLastProposalId, parseNearToYocto } from '../near/dao.js';
import { runAgentTurn, claimAgentSlot } from '../ai/agent.js';
import type { AgentEnv } from '../ai/agentTools.js';
import { runDetached } from './background.js';
import { RETENTION_DAYS } from './worker.js';
import { newTaskScene } from './scenes/newTask.js';
import { applyScene } from './scenes/apply.js';
import { submitScene } from './scenes/submit.js';
import { reviewNoteScene } from './scenes/review.js';
import { unassignScene } from './scenes/unassign.js';
import { t, localeOf } from './i18n.js';
import * as ai from '../ai/assist.js';

const help = async (ctx: BotContext): Promise<string> => {
  const uid = ctx.from?.id;
  return t(localeOf(ctx), 'help.text', {
    admin: isAdmin(uid),
    roomAdmin: uid !== undefined && (await listRoomsAdministeredBy(uid)).length > 0,
    ai: ai.aiEnabled(),
    dao: Boolean(config.daoContractId),
    support: config.supportContact || null,
  });
};

/**
 * Command-side gate for GLOBAL-admin commands (/newtask, /admin, /forget —
 * anything not scoped to a room). Refuses non-admins with the standard reply,
 * and gates on a private chat — admin replies render contributor PII (pitches,
 * ids, raw submissions) and must never land in a group the bot sits in (e.g.
 * the announcement group, where commands still arrive under Telegram's default
 * privacy mode).
 */
async function requireAdminCmd(ctx: BotContext): Promise<boolean> {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply(t(localeOf(ctx), 'common.adminsOnly'));
    return false;
  }
  return requirePrivateChat(ctx, 'common.adminPrivateOnly');
}

/** Deep link to a proposal in the operator's governance UI (the DAO_PROPOSAL_URL
 *  template), or null when none is configured — the bot shows where to verify
 *  and vote, never a voting affordance of its own. */
function proposalUrl(id: number | null): string | null {
  return id != null && config.daoProposalUrl !== '' ? config.daoProposalUrl.replaceAll('{id}', String(id)) : null;
}

/** The single pending payout `taskId` names, or null after replying why not
 *  (none, or several — multi-assignee payout targeting isn't built yet). */
async function singleTaskPayout(ctx: BotContext, L: string, taskId: number): Promise<Payout | null> {
  const rows = await listPendingPayoutsForTask(taskId);
  if (rows.length === 1) return rows[0];
  await ctx.reply(
    rows.length === 0
      ? t(L, 'payouts.noneForTask', { taskId })
      : t(L, 'payouts.multipleForTask', { taskId, count: rows.length }),
  );
  return null;
}

/**
 * Manager scope with NO side effects — 'all' for a global admin, the set of
 * administered room chat ids for a room admin, null for neither. The command
 * gate (requireManagerCmd) layers refusal replies and the private-chat check on
 * top; a callback re-check (paginator nav, /review continuation) uses this bare
 * form, since its card already lives in the DM it was sent to.
 */
async function resolveScope(uid: number | undefined): Promise<'all' | Set<number> | null> {
  if (isAdmin(uid)) return 'all';
  const roomIds = uid === undefined ? [] : await listRoomsAdministeredBy(uid);
  return roomIds.length ? new Set(roomIds) : null;
}

/**
 * Command-side gate for task-management commands: resolveScope plus the
 * standard refusal and the same private-chat gate as requireAdminCmd — a room
 * admin's replies render the same contributor PII a global admin's do.
 */
async function requireManagerCmd(ctx: BotContext): Promise<'all' | Set<number> | null> {
  const scope = await resolveScope(ctx.from?.id);
  if (!scope) {
    await ctx.reply(t(localeOf(ctx), 'common.adminsOnly'));
    return null;
  }
  return (await requirePrivateChat(ctx, 'common.adminPrivateOnly')) ? scope : null;
}

/** Whether a task falls inside a requireManagerCmd scope. */
const inScope = (scope: 'all' | Set<number>, task: Pick<Task, 'room_chat_id'> | undefined): boolean =>
  scope === 'all' || (task?.room_chat_id != null && scope.has(task.room_chat_id));

/**
 * Is this group text message directed at the bot? Only addressed messages reach
 * the agent in an AI-mode room; everything else stays ambient chatter for signal
 * detection, so the two features compose. Two unambiguous gestures: an @mention
 * of the bot (needs BOT_USERNAME), or a reply to one of the bot's own messages
 * (needs ctx.botInfo, which Telegraf populates at launch — also how a multi-turn
 * clarifying answer naturally comes back).
 *
 * A FORWARDED message never addresses the bot: the agent runs under the
 * SENDER's identity and privileges (isManager, tool access), but a forward's
 * text was authored by someone else — a manager relaying "look what this person
 * sent" must not have attacker-worded text drive a tool-firing turn as if the
 * manager typed it. Forwards stay ambient chatter like any other group text.
 */
function addressesBot(ctx: BotContext): boolean {
  const msg = ctx.message;
  if (msg === undefined || !('text' in msg)) return false;
  if ('forward_origin' in msg && msg.forward_origin !== undefined) return false;
  const botId = ctx.botInfo?.id;
  if (botId !== undefined && msg.reply_to_message?.from?.id === botId) return true;
  const uname = config.botUsername;
  return uname !== '' && new RegExp(`@${uname}(?:\\b|$)`, 'i').test(msg.text);
}

/**
 * Callback-side twin of canManageTask: a gate for callbackMutation. Resolves
 * the task lazily (via the application or submission on the card) — when the
 * row is gone, only global admins proceed to the mutation's own "not found";
 * everyone else gets the standard refusal, which never confirms existence.
 */
function requireManageCb(resolveTask: () => Promise<Task | undefined>) {
  return async (ctx: BotContext): Promise<boolean> => {
    if (await canManageTask(ctx.from?.id, await resolveTask())) return true;
    await safeAnswerCb(ctx, t(localeOf(ctx), 'common.adminsOnly'), { show_alert: true });
    return false;
  };
}

/**
 * Contributor-side twin of the requireAdminCmd private-chat gate: these
 * commands render the invoker's own applications and profile, which don't
 * belong in a group chat they happen to share with the bot (and the buttons
 * they carry only work in a DM anyway — the wizards are private-gated).
 */
const requirePrivateCmd = (ctx: BotContext): Promise<boolean> =>
  requirePrivateChat(ctx, 'common.privateOnly');

/**
 * Callback twin of requirePrivateCmd, for button families whose cards are only
 * ever POSTED in DMs (the home menu, withdraw). Callback data is
 * client-tamperable: a matching callback arriving from a group can only be
 * forged onto some group message the bot sent — refuse it before it dumps
 * personal data into the group or lets callbackMutation's card edit rewrite a
 * shared surface (e.g. the announcement post).
 */
async function requirePrivateCb(ctx: BotContext): Promise<boolean> {
  if (ctx.chat?.type === 'private') return true;
  await safeAnswerCb(ctx, t(localeOf(ctx), 'common.privateOnly', { username: config.botUsername || null }), {
    show_alert: true,
  });
  return false;
}

/**
 * The callback_data of every button on a callback's HOST message. The host
 * message and its keyboard arrive server-attested in the update — the one
 * provenance a forged callback can't fake, since callback data itself is
 * client-tamperable. The ONE extraction behind every host-provenance check
 * (callbackMutation's exact-match, the pg: pager's class-match) — the
 * predicates differ deliberately, the extraction must not.
 */
function hostButtonData(ctx: BotContext): string[] {
  const host = ctx.callbackQuery?.message;
  const keyboard = host && 'reply_markup' in host ? host.reply_markup?.inline_keyboard : undefined;
  return keyboard?.flat().flatMap((b) => ('callback_data' in b ? [b.callback_data] : [])) ?? [];
}

/** The error popup for a thrown callback handler. Every path out of a
 *  bot.action must still answer the query — an unanswered query is a stuck
 *  spinner and, minutes later, a dead button — so catch blocks funnel here. */
function answerCbError(ctx: BotContext, L: string, err: unknown): Promise<unknown> {
  return safeAnswerCb(ctx, errorMessage(err, t(L, 'common.somethingWrong')), { show_alert: true });
}

/**
 * Shared skeleton for callback buttons that commit one service mutation.
 * It pins three easy-to-drop invariants in one place:
 *  - the mutation and its outcome enqueue COMMIT TOGETHER: the follow-up DM is
 *    one-shot (a retry tap bounces off the service guard, so its dedup key is
 *    never revisited) — enqueued after the commit, a crash between the two
 *    would lose it permanently. A failure rolls both back and shows the error
 *    popup; the admin simply taps again.
 *  - every path out answers the callback (an unanswered query is a stuck
 *    spinner and, minutes later, a dead button);
 *  - the card edit tolerates a stale or deleted card instead of throwing.
 * `gate` is the role check (requireManageCb), or null when the service mutation
 * enforces ownership itself (withdraw).
 */
async function callbackMutation<T>(
  ctx: BotContext,
  gate: ((ctx: BotContext) => Promise<boolean>) | null,
  mutate: () => Promise<T>,
  outcome: (result: T, L: string) => Promise<{ enqueue?: () => void | Promise<void>; popup: string; card: string }>,
): Promise<void> {
  if (gate && !(await gate(ctx))) return;
  const L = localeOf(ctx);
  let popup: string;
  let card: string;
  try {
    ({ popup, card } = await withTransaction(async () => {
      const result = await mutate();
      const out = await outcome(result, L);
      await out.enqueue?.();
      return out;
    }));
  } catch (err) {
    await answerCbError(ctx, L, err);
    return;
  }
  await safeAnswerCb(ctx, popup);
  // Edit only a host message that actually CARRIES the tapped button
  // (hostButtonData — the same provenance rule as the pg: paginator, exact
  // match here because a mutation card is single-audience). Without this, a
  // user who passes the role gate could attach e.g. `approve:<their draft>` to
  // ANY message the bot ever sent (an announcement post, another room's card)
  // and have this edit rewrite it. The mutation itself is theirs to make
  // either way; the defacement is not.
  const tapped = ctx.callbackQuery && 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
  if (tapped !== undefined && hostButtonData(ctx).includes(tapped)) {
    await ctx.editMessageText(card).catch(() => undefined);
  }
}

/**
 * Serialize update handling per user — wizard-scene session state is not safe
 * under concurrent same-user updates (Telegraf processes a getUpdates batch
 * concurrently).
 */
function perUserQueue() {
  const tails = new Map<number, Promise<unknown>>();
  return async (ctx: BotContext, next: () => Promise<void>): Promise<void> => {
    const key = ctx.from?.id;
    if (key === undefined) return next();
    const prev = tails.get(key) ?? Promise.resolve();
    const current = prev.then(next, next);
    const chained = current.catch(() => undefined);
    tails.set(key, chained);
    try {
      await current;
    } finally {
      if (tails.get(key) === chained) tails.delete(key);
    }
  };
}

export function createBot(): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(config.botToken);
  const stage = new Scenes.Stage<BotContext>([
    newTaskScene,
    applyScene,
    submitScene,
    reviewNoteScene,
    unassignScene,
  ]);

  // Ignore updates with no human sender (channel posts, service messages):
  // every handler assumes ctx.from, and the bot has no channel-side features —
  // without this, such updates die as undefined-binding errors in bot.catch.
  bot.use((ctx, next) => (ctx.from ? next() : undefined));
  // Every reply and card edit goes out as HTML — bold headers, tap-to-copy
  // <code> ids, expandable blockquotes (see src/bot/format.ts, which escapes all
  // dynamic content). Injecting parse_mode once here (and in the notification
  // worker) frees every call site from remembering it; the invariant callers
  // must keep is that the text they pass is already HTML-safe — catalog strings
  // and format.ts builders are, and free-form model output is escaped at source.
  bot.use((ctx, next) => {
    const html = (extra: unknown) => ({ parse_mode: 'HTML', ...(extra as Record<string, unknown>) });
    const reply = ctx.reply.bind(ctx);
    const edit = ctx.editMessageText.bind(ctx);
    ctx.reply = ((text: string, extra?: unknown) =>
      reply(text, html(extra) as Parameters<typeof reply>[1])) as typeof ctx.reply;
    ctx.editMessageText = ((text: string, extra?: unknown) =>
      edit(text, html(extra) as Parameters<typeof edit>[1])) as typeof ctx.editMessageText;
    return next();
  });
  bot.use(perUserQueue());
  bot.use(session());
  // Last profile tuple written per user, so a run of updates from one user
  // (every wizard keystroke is a private update) doesn't repeat an identical
  // upsert write. Bounded so a flood of distinct users can't grow it unbounded;
  // eviction just means the next update re-writes, which is correct.
  const profileSeen = new Map<number, string>();
  const PROFILE_CACHE_MAX = 10_000;
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    // Private chats only: groups deliver every member's /commands to the bot,
    // and profiling people who merely typed near it would collect PII from
    // non-users. Every real user path passes through a DM (wizards and the
    // announcement deep-link both force one), so nobody the bot serves is missed.
    if (from && !from.is_bot && ctx.chat?.type === 'private') {
      const username = from.username ?? null;
      const name = displayName(from) || null;
      const lang = from.language_code ?? null;
      const key = JSON.stringify([username, name, lang]);
      if (profileSeen.get(from.id) !== key) {
        await upsertContributor(from.id, username, name, lang);
        if (profileSeen.size >= PROFILE_CACHE_MAX) profileSeen.clear();
        profileSeen.set(from.id, key);
      }
    }
    return next();
  });
  bot.use(stage.middleware());

  // Inline "home" menu under /start and /help so a contributor never has to know
  // the command names — one tap reaches browsing, their work, settings, or help.
  // Inline (not a persistent reply keyboard) on purpose: a reply keyboard would
  // sit in the input area during the apply/submit wizards and a mis-tap would be
  // captured as pitch or submission text. Only shown in a DM (its targets render
  // personal data or the DM-only wizards); the callbacks re-check that below.
  const homeMenu = (L: string) =>
    Markup.inlineKeyboard([
      // The Mini App board, when its origin is configured — a web_app button
      // opens it in-place (only valid in a private chat, which the menu is).
      ...(config.webAppUrl ? [[Markup.button.webApp(t(L, 'btn.home.board'), config.webAppUrl)]] : []),
      [
        Markup.button.callback(t(L, 'btn.home.open'), 'home:open'),
        Markup.button.callback(t(L, 'btn.home.myapps'), 'home:myapps'),
      ],
      [
        Markup.button.callback(t(L, 'btn.home.settings'), 'home:settings'),
        Markup.button.callback(t(L, 'btn.home.help'), 'home:help'),
      ],
    ]);
  const replyHelp = (ctx: BotContext, text: string) =>
    ctx.chat?.type === 'private' ? ctx.reply(text, homeMenu(localeOf(ctx))) : ctx.reply(text);

  // /start may carry a deep-link payload from the announcement channel's Apply
  // button (?start=t<taskId>) — jump straight into applying for that task.
  // A cold /start gets an orientation (what this is, the loop, that work pays)
  // rather than the /help command manifest — a first-time contributor decides
  // whether to stay in the first ten seconds, not from a reference card.
  bot.start(async (ctx) => {
    const match = /^t(\d+)$/.exec(ctx.startPayload ?? '');
    if (match) return ctx.scene.enter(SCENES.apply, { taskId: Number(match[1]) });
    return replyHelp(ctx, t(localeOf(ctx), 'start.welcome', { dao: Boolean(config.daoContractId) }));
  });
  bot.help(async (ctx) => replyHelp(ctx, await help(ctx)));

  // Home-menu taps. All targets are DM-only (My work renders the invoker's
  // applications; the paginators/panel are personal), so the menu is only shown
  // in a DM — and the gate re-checks that, since the callback data could be
  // forged onto any group message the bot sent.
  bot.action(/^home:(open|myapps|settings|help)$/, async (ctx) => {
    if (!(await requirePrivateCb(ctx))) return;
    const L = localeOf(ctx);
    await safeAnswerCb(ctx);
    const what = ctx.match[1];
    if (what === 'open') return void (await sendPage(ctx, await openPage(ctx, 0, L)));
    if (what === 'myapps') return void (await showMyApps(ctx, L));
    if (what === 'settings') return void (await sendPage(ctx, await settingsPanel(ctx, L)));
    return void (await ctx.reply(await help(ctx)));
  });

  // Inline mode (@bot <query> from ANY chat): search the GLOBAL open board and
  // offer each task as a shareable teaser carrying an Apply deep link — the way
  // to spread an agency bounty into other communities without leaving the chat.
  // Also what the /open "Share" button (switch_inline_query) drives. Global
  // tasks only: an inline result can land in any chat, and a room task is
  // room-scoped — the bot must not amplify it beyond its group (see
  // service.listOpenTasks). Requires inline mode enabled in BotFather.
  //
  // Telegram fires an inline_query per KEYSTROKE, and every query derives from
  // the same live open-task list — memo it for the window the answer's
  // cache_time already grants the Telegram-side cache, so typing a query costs
  // one task fetch, not one per character. No invalidation on task mutations: a
  // board change appears here within the same staleness the client cache allows.
  const INLINE_CACHE_SECONDS = 10;
  let inlineOpenTasks: { at: number; tasks: Task[] } | null = null;
  bot.on('inline_query', async (ctx) => {
    const L = localeOf(ctx);
    const q = ctx.inlineQuery.query.trim().toLowerCase();
    if (!inlineOpenTasks || Date.now() - inlineOpenTasks.at > INLINE_CACHE_SECONDS * 1000) {
      inlineOpenTasks = { at: Date.now(), tasks: await listOpenTasks() };
    }
    const open = inlineOpenTasks.tasks;
    const matches = (
      q ? open.filter((tk) => tk.title.toLowerCase().includes(q) || (tk.reward ?? '').toLowerCase().includes(q)) : open
    ).slice(0, 25);
    const results = matches.map((task) => ({
      type: 'article' as const,
      id: String(task.id),
      // title/description are plain-text result-list fields — never HTML-parsed.
      // safeSlice, not slice: a cut mid-emoji leaves an unpaired surrogate that
      // renders as a stray U+FFFD in the result list.
      title: safeSlice(task.title, 100),
      description:
        safeSlice(
          [
            task.reward ? `🎁 ${task.reward}` : '',
            task.deadline ? `⏳ ${task.deadline}` : '',
            task.max_assignees > 1 ? `👥 ${task.max_assignees}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          100,
        ) || t(L, 'inline.openTask'),
      input_message_content: { message_text: taskShareText(task), parse_mode: 'HTML' as const },
      ...(config.botUsername
        ? { reply_markup: deepLinkApplyButton(task, config.botUsername, L).reply_markup }
        : {}),
    }));
    // Short cache — results track the live open-task set; public tasks, not personal.
    await ctx.answerInlineQuery(results, { cache_time: INLINE_CACHE_SECONDS });
  });

  // Transparency surface: what's stored, retention, the AI third-party flow
  // (when enabled), and how erasure works. Contains no personal data itself,
  // so it answers anywhere — including groups, where the curious will ask.
  // The retention numbers come from the constants that enforce them, so the
  // statement can't silently drift from the mechanism.
  bot.command('terms', (ctx) =>
    ctx.reply(
      t(localeOf(ctx), 'terms.text', {
        dao: Boolean(config.daoContractId),
        support: config.supportContact || null,
      }),
    ),
  );

  bot.command('privacy', (ctx) =>
    ctx.reply(
      t(localeOf(ctx), 'privacy.text', {
        ai: ai.aiEnabled(),
        notifRetentionDays: RETENTION_DAYS,
        support: config.supportContact || null,
      }),
    ),
  );
  bot.command('cancel', (ctx) => ctx.reply(t(localeOf(ctx), 'common.nothingToCancel')));

  // ---- Task creation & approval (admin) ----
  bot.command('newtask', async (ctx) => {
    if (!(await requireAdminCmd(ctx))) return;
    return ctx.scene.enter(SCENES.newTask);
  });

  // Per-row reply loops cap here: Telegram sustains ~1 msg/s per chat, so an
  // unbounded list would drip for minutes, flood the chat, and eventually 429
  // mid-loop — silently truncating with no notice. Capped lists always say so
  // ('list.more'); acting on the shown items shrinks the queues. (/open,
  // /applicants, /active, /review page instead — see the paginators below.)
  const LIST_PAGE = 15;
  // /active packs its rows into ONE editable message (the paginator), unlike the
  // one-reply-per-row lists above — so its page size must provably fit Telegram's
  // 4096-char cap. Worst-case activeLine ≈ 280 chars (90-char title field,
  // 64-char who() label, ids/status/age/separators): 10 rows + header + hint
  // ≈ 3.1k, comfortably under. clampMessage stays as the backstop only.
  const ACTIVE_PAGE = 10;
  // /status history events kept per view (the newest ones; older are summarized
  // by a "showing latest N of M" line).
  const HISTORY_PAGE = 25;

  /** One reply per row, capped at LIST_PAGE, always followed by a "more" notice
   *  when cut — so a truncated list never masquerades as the whole thing. */
  async function listCapped<T>(
    ctx: BotContext,
    L: string,
    items: T[],
    render: (item: T) => Promise<unknown>,
  ): Promise<void> {
    for (const item of items.slice(0, LIST_PAGE)) await render(item);
    if (items.length > LIST_PAGE) {
      await ctx.reply(t(L, 'list.more', { shown: LIST_PAGE, total: items.length }));
    }
  }

  // ---- Single-message paginators (/open, /applicants, /active) ----
  // One editable card plus a ◀ i/N ▶ nav row. Telegram keeps no state, so a page
  // tap re-derives the whole list and re-checks auth server-side, clamps the
  // requested page (the list may have shrunk since the card was sent), and edits
  // the message in place. Callback data is `pg:<surface>:<arg>:<page>` (arg is a
  // task id for /applicants, 0 otherwise) — a dozen bytes, under the 64-byte cap.
  // /review is deliberately excluded: its cards carry media attachments, which
  // cannot live inside an edited text message (it gets a Next-page button instead).
  type Btn =
    | ReturnType<typeof Markup.button.callback>
    | ReturnType<typeof Markup.button.url>
    | ReturnType<typeof Markup.button.switchToChat>;
  interface PageView {
    text: string;
    rows: Btn[][];
  }

  const clampPage = (page: number, total: number): number => Math.min(Math.max(page, 0), Math.max(0, total - 1));

  const navRow = (key: string, arg: number, page: number, total: number, L: string): Btn[][] => {
    if (total <= 1) return [];
    const nav: Btn[] = [];
    if (page > 0) nav.push(Markup.button.callback(t(L, 'btn.prev'), `pg:${key}:${arg}:${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1}/${total}`, 'pg:noop'));
    if (page < total - 1) nav.push(Markup.button.callback(t(L, 'btn.next'), `pg:${key}:${arg}:${page + 1}`));
    return [nav];
  };

  // Apply affordance for one open task — placement rule shared with the agent's
  // propose_apply (see applyAffordanceBtn in keyboards.ts).
  const applyButtonFor = (ctx: BotContext, task: Task, L: string): Btn | null =>
    applyAffordanceBtn(task, ctx.chat?.type === 'private', config.botUsername, L);

  async function openPage(ctx: BotContext, page: number, L: string): Promise<PageView> {
    // Room-scoped (see service.listOpenTasks): in a group, that room's tasks
    // plus the global board; in a DM (or anywhere else), the global board only.
    const inGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    const open = await listOpenTasks(inGroup ? ctx.chat!.id : null);
    if (open.length === 0) return { text: t(L, 'open.none'), rows: [] };
    const p = clampPage(page, open.length);
    const task = open[p];
    const assigned = await countSlotsTaken(task.id);
    // Fully assigned: still browsable, but there is nothing to apply to. Share
    // opens the inline picker (switch_inline_query) prefilled with this task, so
    // a member can drop it into any other chat — see the inline_query handler.
    const action: Btn[] = [];
    const apply = assigned < task.max_assignees ? applyButtonFor(ctx, task, L) : null;
    if (apply) action.push(apply);
    // Inline queries cap at 256 chars — a plain prefix cut (no ellipsis) keeps
    // the prefilled query a prefix the inline handler's includes() filter still
    // matches; safeSlice so a mid-emoji cut can't end it in U+FFFD (which would
    // match nothing). Room tasks get no Share button: the inline result set is
    // the GLOBAL board (a room task must not spread bot-amplified into other
    // chats), so the prefilled query would find nothing — members forward the
    // room announcement natively instead.
    if (task.room_chat_id == null) {
      action.push(Markup.button.switchToChat(t(L, 'btn.share'), safeSlice(task.title, 256)));
    }
    return { text: taskDetail(task, assigned), rows: [action, ...navRow('open', 0, p, open.length, L)] };
  }

  async function applicantsPage(task: Task, page: number, L: string): Promise<PageView> {
    const [applicants, assigned] = await Promise.all([listApplicantsAwaiting(task.id), countSlotsTaken(task.id)]);
    const header = t(L, 'applicants.header', {
      id: task.id,
      title: truncate(task.title, 200),
      assigned,
      max: task.max_assignees,
      n: applicants.length,
    });
    if (applicants.length === 0) return { text: header, rows: [] };
    const p = clampPage(page, applicants.length);
    const app = applicants[p];
    const c = await getContributor(app.contributor_id);
    const actions: Btn[] = applicantRow(app, L);
    return { text: `${header}\n\n${applicantCard(app, c)}`, rows: [actions, ...navRow('appl', task.id, p, applicants.length, L)] };
  }

  async function activePage(scope: 'all' | Set<number>, page: number, L: string): Promise<PageView> {
    const assignments = await listActiveAssignments();
    const tasksById = new Map(
      (await listTasksByIds([...new Set(assignments.map((a) => a.task_id))])).map((tk) => [tk.id, tk]),
    );
    const active = assignments
      .map((app) => ({ app, task: tasksById.get(app.task_id) }))
      .filter(({ task }) => inScope(scope, task));
    if (active.length === 0) return { text: t(L, 'active.none'), rows: [] };
    const pages = Math.ceil(active.length / ACTIVE_PAGE);
    const p = clampPage(page, pages);
    const slice = active.slice(p * ACTIVE_PAGE, p * ACTIVE_PAGE + ACTIVE_PAGE);
    const [latestByApp, byId] = await Promise.all([
      latestSubmissionsByApplication(slice.map(({ app }) => app.id)),
      listContributorsByIds([...new Set(slice.map(({ app }) => app.contributor_id))]).then(
        (cs) => new Map(cs.map((c) => [c.telegram_id, c])),
      ),
    ]);
    const lines = slice.map(({ app, task }) =>
      activeLine(app, task, latestByApp.get(app.id), byId.get(app.contributor_id)),
    );
    const text = clampMessage(`${t(L, 'active.header', { n: active.length, lines: lines.join('\n') })}\n\n${t(L, 'active.hint')}`);
    return { text, rows: navRow('actv', 0, p, pages, L) };
  }

  const sendPage = (ctx: BotContext, view: PageView): Promise<unknown> =>
    ctx.reply(view.text, Markup.inlineKeyboard(view.rows));
  const editPage = (ctx: BotContext, view: PageView): Promise<unknown> =>
    ctx.editMessageText(view.text, Markup.inlineKeyboard(view.rows)).catch(() => undefined);

  // The i/N indicator is a live button (Telegram has no inert buttons); it just acks.
  bot.action('pg:noop', (ctx) => safeAnswerCb(ctx));
  bot.action(/^pg:(open|appl|actv):(\d+):(\d+)$/, async (ctx) => {
    // /open pages live in groups too, so a private-chat gate (the home:*
    // pattern) would break legit group pagination. The forged-callback risk is
    // editPage rewriting a DIFFERENT bot message (e.g. the shared announcement):
    // close it by only editing a message that IS a paginator — the host
    // message + keyboard arrive server-attested in the callback update, so a
    // pg: callback forged onto anything without pg: nav buttons is refused.
    // Class-match (not exact) on purpose: a shared group pager's keyboard is
    // edited under concurrent taps, so the exact tapped data may already be
    // one page stale — carrying pg: buttons at all is the provenance.
    const isPager = hostButtonData(ctx).some((d) => d.startsWith('pg:'));
    if (!isPager) return void safeAnswerCb(ctx);
    const key = ctx.match[1];
    // The manager pages (applicants, active work) are only ever POSTED in DMs —
    // arriving from a group they're forged onto a legit group /open paginator,
    // and editPage would rewrite it into applicant pitches / assignee names in
    // front of the whole group. Same DM-only-card rule as requirePrivateCb.
    if (key !== 'open' && !(await requirePrivateCb(ctx))) return;
    const arg = Number(ctx.match[2]);
    const page = Number(ctx.match[3]);
    const L = localeOf(ctx);
    // The page build is several DB reads — a throw mid-build must still answer
    // the callback (as an error popup), or the nav tap spins forever.
    let view: PageView;
    try {
      if (key === 'appl') {
        // The card outlives a demotion — re-check management of THIS task per tap.
        const task = await getTask(arg);
        if (!(await requireManageCb(async () => task)(ctx))) return;
        // A global admin passes the gate even when the row is gone — mirror the
        // command's "not manageable" reply instead of rendering a page.
        view = task ? await applicantsPage(task, page, L) : { text: t(L, 'task.notManageable', { id: arg }), rows: [] };
      } else if (key === 'actv') {
        const scope = await resolveScope(ctx.from?.id);
        if (!scope) return void safeAnswerCb(ctx, t(L, 'common.adminsOnly'), { show_alert: true });
        view = await activePage(scope, page, L);
      } else {
        view = await openPage(ctx, page, L);
      }
    } catch (err) {
      return void answerCbError(ctx, L, err);
    }
    await safeAnswerCb(ctx);
    await editPage(ctx, view);
  });

  /** Work is due on an assignment iff submitWork would accept a new version —
   *  the SAME guard chain (submitRefusal), evaluated advisorily. Every surface
   *  offering a Submit button uses this, so a tap can never be a guaranteed
   *  bounce off the service guard. */
  const workDue = (app: Application, latest: Submission | undefined): boolean =>
    submitRefusal(app, latest) === null;

  /** Render a contributor's work rows (applicationsWithContext), capped at
   *  LIST_PAGE; `buttonFor` picks each row's button (or none). */
  async function renderApplicationList(
    ctx: BotContext,
    L: string,
    rows: ApplicationContext[],
    buttonFor: (app: Application, latest: Submission | undefined) => ReturnType<typeof submitButton> | undefined,
  ): Promise<void> {
    await listCapped(ctx, L, rows, async ({ application, task, latest }) => {
      const line = applicationLine(application, task, latest);
      const button = buttonFor(application, latest);
      return button ? ctx.reply(line, button) : ctx.reply(line);
    });
  }

  bot.command('approve', async (ctx) => {
    const L = localeOf(ctx);
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    const drafts = (await listDraftTasks()).filter((task) => inScope(scope, task));
    if (drafts.length === 0) return ctx.reply(t(L, 'approve.none'));
    await ctx.reply(t(L, 'approve.count', { n: drafts.length }));
    await listCapped(ctx, L, drafts, (task) => ctx.reply(taskDetail(task, 0), draftButtons(task, L)));
  });

  // ---- Open tasks & applying ----
  // Browse open tasks one card at a time, flipping with ◀ ▶ (see the paginator
  // block above). Public: works in a DM and in a group the bot is in.
  bot.command('open', async (ctx) => {
    await sendPage(ctx, await openPage(ctx, 0, localeOf(ctx)));
  });

  // ---- A contributor's own applications ----
  // Factored out so the home-menu "My work" button (home:myapps) renders the
  // same profile + application list the /myapps command does.
  async function showMyApps(ctx: BotContext, L: string): Promise<void> {
    const uid = ctx.from!.id;
    const [rows, profile] = await Promise.all([applicationsWithContext(uid), getContributor(uid)]);
    if (rows.length === 0) {
      await ctx.reply(`${profile ? contributorProfile(profile) + '\n\n' : ''}${t(L, 'myapps.none')}`);
      return;
    }
    if (profile) await ctx.reply(contributorProfile(profile));
    await renderApplicationList(ctx, L, rows, (app, latest) => {
      // Only offer a button the service will actually accept: Submit when work
      // is due (workDue), Withdraw only while still an applicant. Assignments
      // awaiting review or finished (completed/rejected) get no button — those
      // taps would only fail.
      if (workDue(app, latest)) return submitButton(app, L);
      if (app.status === ApplicationStatus.Applied) return withdrawButton(app, L);
      return undefined;
    });
  }

  bot.command('myapps', async (ctx) => {
    if (!(await requirePrivateCmd(ctx))) return;
    await showMyApps(ctx, localeOf(ctx));
  });

  // ---- Submitting work ----
  bot.command('submit', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    const uid = ctx.from!.id;
    const raw = commandArg(ctx);
    if (raw !== undefined) {
      const id = parseId(raw);
      if (id === null) return ctx.reply(t(L, 'submit.usage'));
      return ctx.scene.enter(SCENES.submit, { applicationId: id });
    }
    // Offer only assignments where work is actually due (workDue) — an
    // awaiting-review assignment would render a Submit button whose tap can
    // only bounce off submitWork's guard.
    const due = (await applicationsWithContext(uid)).filter(({ application, latest }) =>
      workDue(application, latest),
    );
    if (due.length === 0) return ctx.reply(t(L, 'submit.none'));
    if (due.length === 1) return ctx.scene.enter(SCENES.submit, { applicationId: due[0].application.id });
    await ctx.reply(t(L, 'submit.which'));
    await renderApplicationList(ctx, L, due, (app) => submitButton(app, L));
  });

  // ---- Task-announcement DM opt-in (contributor-controlled) ----
  bot.command('notify', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    const uid = ctx.from!.id;
    const arg = commandArg(ctx)?.toLowerCase();
    if (arg === 'on' || arg === 'off') {
      await setAnnounceOptIn(uid, arg === 'on');
      return ctx.reply(t(L, arg === 'on' ? 'optin.on' : 'optin.off'));
    }
    return ctx.reply(t(L, 'optin.status', { on: (await getContributor(uid))?.announce_opt_in === 1 }));
  });

  bot.command('withdraw', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'withdraw.usage'));
    try {
      const app = await withdrawApplication(id, ctx.from!.id);
      await ctx.reply(t(L, 'withdraw.ok', { taskId: app.task_id }));
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'withdraw.fail')));
    }
  });

  // ---- Applicant review & assignment (admin) ----
  bot.command('applicants', async (ctx) => {
    const L = localeOf(ctx);
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'applicants.usage'));
    const task = await getTask(id);
    // Out-of-scope reads like missing — a room admin can't enumerate other
    // rooms' task ids by probing (same pattern as ownApplication).
    if (!task || !inScope(scope, task)) return ctx.reply(t(L, 'task.notManageable', { id }));
    // One applicant per card, Assign / Decline + ◀ ▶ to flip through the pool.
    await sendPage(ctx, await applicantsPage(task, 0, L));
  });

  // ---- Active assignments (admin) ----
  // A page of in-progress assignments (read-only rows), ◀ ▶ between pages.
  bot.command('active', async (ctx) => {
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    await sendPage(ctx, await activePage(scope, 0, localeOf(ctx)));
  });

  // ---- Admin overview: counts only, pointing at the commands that act ----
  bot.command('admin', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const perTask = await countApplicationsAwaitingPerTask();
    const where = perTask.length
      ? ` (${perTask.map((r) => `#${r.task_id}×${r.n}`).join(' ')})`
      : '';
    const [notif, drafts, open, active, stale, review, ages] = await Promise.all([
      notificationCounts(),
      countDraftTasks(),
      countOpenTasks(),
      countActiveAssignments(),
      countStaleAssignments(config.staleAssignedDays),
      countSubmittedForReview(),
      queueAges(),
    ]);
    // clampMessage: the per-task `where` breakdown grows with the task count.
    await ctx.reply(
      clampMessage(
        t(L, 'admin.overview', {
          drafts,
          open,
          applications: perTask.reduce((sum, r) => sum + r.n, 0),
          where,
          active,
          stale,
          staleDays: config.staleAssignedDays,
          review,
          notifQueued: notif.queued + notif.retrying,
          notifFailed: notif.failed,
          oldestApplicationDays: ages.applicationDays,
          oldestReviewDays: ages.reviewDays,
        }),
      ),
    );
  });

  // ---- Funnel stats (admin): is the loop actually working? ----
  // Counts only, derived from the workflow tables — the launch-question gauge
  // (activation, throughput, settlement) without an analytics pipeline.
  bot.command('stats', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const s = await productStats();
    await ctx.reply(
      t(L, 'stats.overview', {
        ...s,
        activationPct: s.contributors > 0 ? Math.round((100 * s.applicants) / s.contributors) : null,
      }),
    );
  });

  // ---- Config preflight (admin) ----
  // Pass/fail the wiring that otherwise fails silently and LATE: a wrong
  // announce chat surfaces at approval time as an announcement nobody sees; a
  // missing OutLayer key at the first real /pay, in front of a waiting
  // contributor. Run this after deploy and any env change.
  bot.command('diag', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const oops = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    const lines: string[] = [t(L, 'diag.title')];
    try {
      await countOpenTasks();
      lines.push(t(L, 'diag.db', { ok: true }));
    } catch {
      lines.push(t(L, 'diag.db', { ok: false }));
    }
    lines.push(t(L, 'diag.admins', { n: config.adminIds.size }));
    if (!config.announceChatId) lines.push(t(L, 'diag.announceMissing'));
    else {
      try {
        const chat = await ctx.telegram.getChat(config.announceChatId);
        lines.push(t(L, 'diag.announceOk', { title: 'title' in chat ? chat.title ?? '' : '' }));
      } catch (err) {
        lines.push(t(L, 'diag.announceFail', { error: oops(err) }));
      }
    }
    try {
      const me = await ctx.telegram.getMe();
      lines.push(t(L, me.can_read_all_group_messages ? 'diag.privacyOff' : 'diag.privacyOn'));
    } catch {
      // Purely informational — getMe failing here will show up everywhere else anyway.
    }
    if (!config.daoContractId) lines.push(t(L, 'diag.daoOff'));
    else {
      const started = Date.now();
      try {
        // getLastProposalId, NOT getPolicy: the policy is served from a 60s
        // in-module cache, so a cached read would report "DAO OK (~0ms)" while
        // the RPC is down — the exact silent failure /diag exists to surface.
        await getLastProposalId();
        lines.push(t(L, 'diag.daoOk', { dao: config.daoContractId, ms: Date.now() - started }));
      } catch (err) {
        lines.push(t(L, 'diag.daoFail', { dao: config.daoContractId, error: oops(err) }));
      }
    }
    lines.push(
      config.outlayerApiKey
        ? t(L, 'diag.outlayerOn')
        : t(L, 'diag.outlayerOff', { daoOn: Boolean(config.daoContractId) }),
    );
    lines.push(config.webPort ? t(L, 'diag.webOn', { url: config.webAppUrl }) : t(L, 'diag.webOff'));
    lines.push(ai.aiEnabled() ? t(L, 'diag.aiOn') : t(L, 'diag.aiOff'));
    await ctx.reply(clampMessage(lines.join('\n')));
  });

  // ---- A contributor's own payouts ----
  // The bot-side twin of the Mini App's myPayouts: without it a contributor had
  // no way to see money owed to them unless the Mini App was deployed — the
  // admin queue below is admin-only. Same reconcile dispatch, contributor-toned
  // status lines, one clamped message (own payout counts stay small).
  async function myPayoutsView(ctx: BotContext, L: string): Promise<void> {
    if (!(await requirePrivateCmd(ctx))) return;
    const uid = ctx.from!.id;
    const rows = await listPayoutsByContributor(uid);
    if (rows.length === 0) return void (await ctx.reply(t(L, 'payouts.mineNone')));
    const railConfigured = Boolean(config.daoContractId);
    const window = proposalWindow();
    // reconcilePayout owns the rail-off case (it returns the row's committed
    // state, read-free) — a caller-side skip here once hand-rolled that state
    // and drifted (hardcoded attention:false), rendering the same row
    // differently than the Mini App.
    const recs = await Promise.all(rows.map((p) => reconcilePayout(p, window)));
    const tasksById = new Map(
      (await listTasksByIds([...new Set(rows.map((p) => p.task_id))])).map((tk) => [tk.id, tk]),
    );
    const lines = rows.map((p, i) => {
      const rec = recs[i];
      // Wording keys off the rail even though the reconcile no longer does:
      // with no DAO configured, "queued — proposed to the DAO next" promises a
      // flow that will never run; the honest line is off-platform settlement.
      // `held` is the benign young-claim case (the admin surface's claimHeld
      // twin), and a live duplicate proposal folds into the attention wording —
      // the same fold the Mini App applies (web/api.ts myPayouts).
      const statusKey =
        rec.status === 'paid'
          ? 'payouts.mineStatus.paid'
          : !railConfigured
            ? 'payouts.mineStatus.recorded'
            : !rec.ok
              ? rec.held
                ? 'payouts.mineStatus.held'
                : 'payouts.mineStatus.checkFailed'
              : rec.attention || rec.duplicateProposals
                ? 'payouts.mineStatus.attention'
                : rec.status === 'proposed'
                  ? 'payouts.mineStatus.proposed'
                  : 'payouts.mineStatus.pending';
      const pinned = pinnedAmountNear(p, rec);
      return t(L, 'payouts.mineLine', {
        taskId: p.task_id,
        title: tasksById.get(p.task_id)?.title ?? null,
        reward: p.reward,
        amountNear: pinned,
        status: t(L, statusKey),
      });
    });
    const parts = [t(L, 'payouts.mineHeader'), ...lines];
    const unsettled = recs.some((r) => r.status !== 'paid');
    // Who releases the money: the row statuses say "the council" — this says
    // what that is, once per view, whenever an on-chain settlement lies ahead.
    if (railConfigured && unsettled) {
      parts.push('', t(L, 'payouts.mineCouncilNote', { support: config.supportContact || null }));
    }
    // The funnel nudge, where the money is actually blocked on the contributor:
    // an unpaid payout with no saved account cannot be sent anywhere.
    if (railConfigured && unsettled && (await getPayoutAccount(uid)) === null) {
      parts.push('', t(L, 'notify.paytoNudge'));
    }
    await ctx.reply(clampMessage(parts.join('\n')));
  }

  // ---- DAO payout queue (admin) ----
  // The bot holds NO fund-moving key: it reads the DAO to show which owed payouts
  // are unstarted vs proposed, flips their status to match, and points the admin
  // at /pay to propose a Transfer the council then approves. Reads only; payment
  // stays a human, key-in-hand DAO vote.
  bot.command('payouts', async (ctx) => {
    const L = localeOf(ctx);
    // Dual-mode: global admins get the settlement queue; everyone else gets
    // their own payouts (requireAdminCmd's "Admins only" would otherwise be the
    // whole contributor experience of the money surface).
    if (!isAdmin(ctx.from?.id)) return void (await myPayoutsView(ctx, L));
    if (!(await requireAdminCmd(ctx))) return;
    // Both open states: pending (unstarted) and proposed (a DAO vote in flight —
    // or a FAILED transfer needing an admin).
    const owed = await listPayoutsByStatus(['pending', 'proposed']);
    if (owed.length === 0) return ctx.reply(t(L, 'payouts.none'));
    // Most-actionable first (oldest first within each status — the sort is
    // stable): pending is what the admin ACTS on here, proposed may need a re-finalize.
    const rank: Record<string, number> = { pending: 0, proposed: 1 };
    owed.sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));
    // One reply per payout, capped like every other admin list (a single joined
    // message would silently clamp past ~12 rows, and a missed row here is
    // missed money). Context and chain reads are fetched for the shown page only;
    // later rows reconcile when they reach a page.
    const page = owed.slice(0, LIST_PAGE);
    const [byId, tasksById] = await Promise.all([
      listContributorsByIds([...new Set(page.map((p) => p.contributor_id))]).then(
        (cs) => new Map(cs.map((c) => [c.telegram_id, c])),
      ),
      listTasksByIds([...new Set(page.map((p) => p.task_id))]).then((ts) => new Map(ts.map((tk) => [tk.id, tk]))),
    ]);
    // Rail-off (no DAO configured) is resolved INSIDE reconcilePayout — it
    // returns the row's committed state without a chain read, so every surface
    // (this queue, myPayoutsView, the Mini App) renders the same answer.
    // railConfigured below only drives the per-row wording (offPlatform).
    const railConfigured = Boolean(config.daoContractId);
    // The chain reads (inside reconcilePayout) are independent: one round trip's
    // latency for the page, not one per row — and one shared proposal-window
    // snapshot (lazy, so it costs nothing when no row needs a scan) for the
    // page, not one fetch per scan-needing row.
    const window = proposalWindow();
    const recs = await Promise.all(page.map((p) => reconcilePayout(p, window)));
    await ctx.reply(t(L, 'payouts.title'));
    // Per-row sends are guarded like sendReviewPage's: a transient failure (a
    // 429, a network blip) stops the listing but MUST fall through to the
    // remainder notice below — an unhandled throw would silently drop the rest
    // of the money queue, and a short list here masquerades as the whole thing.
    let shown = 0;
    for (const [i, p] of page.entries()) {
      const task = tasksById.get(p.task_id);
      const title = task ? ` <b>${field(task.title, 100)}</b>` : '';
      // reward is snapshotted free text with no service-side length cap — budget
      // it like taskDetail does (150), and clampMessage every send below: a 400
      // on one oversized row would abort the loop and silently drop the rest of
      // the money queue.
      // Once proposed/paid, show the exact pinned on-chain amount alongside the
      // advertised (free-text) reward — /pay <amount> can differ from it. The
      // reconciled-status keying lives in pinnedAmountNear (shared with the
      // Mini App), so this surface can't drift from that display invariant.
      const pinned = pinnedAmountNear(p, recs[i]);
      const amt = pinned ? ` · ◈ ${pinned} NEAR` : '';
      const head = `#<code>${p.task_id}</code>${title} — 👤 ${who(p.contributor_id, byId.get(p.contributor_id))} · 🎁 ${field(p.reward, 150)}${amt}`;
      const send = (body: string): Promise<unknown> => ctx.reply(clampMessage(`${head}\n${body}`));
      // The reconciled status is authoritative: once settled we never re-offer a
      // pay action — a re-run would double-pay. A money action shows ONLY off a
      // successful read (`ok`); an unverified read shows "couldn't check" —
      // except the benign `held` case (a young claim awaiting its proposal),
      // which gets its own honest line instead of a phantom RPC error.
      const { ok, status, attention, held, proposalId, duplicateProposals } = recs[i];
      // Render the reconcile's own proposalId (it may have just adopted/pinned one
      // this run), falling back to the pre-reconcile snapshot only if it didn't.
      const pid = proposalId ?? p.proposal_id;
      try {
        // A duplicate live twin (the same identity proposed out-of-band alongside
        // the bot's) is the priority: the council must reject the extra one
        // BEFORE approving anything, or both could pay.
        if (!railConfigured) await send(t(L, 'payouts.offPlatform'));
        else if (duplicateProposals) await send(t(L, 'payouts.duplicate', { proposalId: pid, url: proposalUrl(pid) }));
        else if (status === 'paid') await send(t(L, 'payouts.paid'));
        else if (!ok) await send(t(L, held ? 'payouts.claimHeld' : 'payouts.checkFailed'));
        else if (status === 'proposed') {
          await send(
            t(L, attention ? 'payouts.proposalStuck' : 'payouts.proposed', { proposalId: pid, url: proposalUrl(pid) }),
          );
        }
        // Verified-unstarted pending: /pay proposes a DAO Transfer for it —
        // flagged when the council voted the last proposal down (check first),
        // and named as blocked when the contributor has no payout account yet
        // (otherwise the admin discovers the leak only when /pay refuses).
        else if (attention) await send(t(L, 'payouts.requeued', { taskId: p.task_id }));
        else if (!byId.get(p.contributor_id)?.payout_account) {
          await send(t(L, 'payouts.noAccount', { taskId: p.task_id }));
        } else await send(t(L, 'payouts.payHint', { taskId: p.task_id }));
      } catch (err) {
        console.error('[payouts] row send failed, stopping listing:', err instanceof Error ? err.message : err);
        break;
      }
      shown += 1;
    }
    if (shown < owed.length) {
      await ctx.reply(t(L, 'list.more', { shown, total: owed.length })).catch(() => undefined);
    }
  });

  // ---- Reviewing submissions (admin) ----
  /**
   * Send one page of the review backlog after submission id `afterId` (0 = the
   * start), then a Next-page button if more remain. Unlike the
   * /open|/applicants|/active paginators this is NOT one editable message: each
   * submission card carries its own decide buttons AND a media attachment, which
   * can't live inside an edited text message — so a page is a run of fresh
   * cards, and the button re-invokes this after the last id it showed. The list
   * is re-derived each call (auth re-checked by the caller); anchoring by id
   * (not offset) means deciding cards — which removes them from the re-derived
   * backlog — can't make Next skip the rows that slid into their places or
   * falsely report the queue empty. Ids ride the query's (created_at, id)
   * ordering, and identity ids are insertion-ordered, so "after id" is "after
   * that row".
   */
  async function sendReviewPage(ctx: BotContext, L: string, scope: 'all' | Set<number>, afterId: number): Promise<void> {
    // Resolve the whole backlog's applications and tasks in two batched queries
    // (not two per submission); only the shown page's contributors are fetched.
    const pending = await listSubmittedForReview();
    const appsById = new Map(
      (await listApplicationsByIds([...new Set(pending.map((s) => s.application_id))])).map((a) => [a.id, a]),
    );
    const tasksById = new Map(
      (await listTasksByIds([...new Set([...appsById.values()].map((a) => a.task_id))])).map((tk) => [tk.id, tk]),
    );
    const subs = pending
      .map((sub) => {
        const app = appsById.get(sub.application_id);
        return { sub, app, task: app ? tasksById.get(app.task_id) : undefined };
      })
      .filter(
        (r): r is { sub: Submission; app: Application; task: Task | undefined } =>
          r.app !== undefined && inScope(scope, r.task),
      );
    const remaining = afterId === 0 ? subs : subs.filter(({ sub }) => sub.id > afterId);
    if (remaining.length === 0) {
      // Undecided cards at or before the anchor were already sent — their decide
      // buttons still work in place — so "none" would be wrong while they exist.
      return void ctx.reply(t(L, subs.length === 0 ? 'review.none' : 'review.end'));
    }
    if (afterId === 0) await ctx.reply(t(L, 'review.count', { n: subs.length }));
    // Budgeted in MESSAGES, not rows: a media submission costs two sends (card +
    // attachment), and it is the send count that trips Telegram's per-chat flood
    // limit the LIST_PAGE cap exists to stay under. One pass selects the rows
    // from `offset` that fit the budget and collects their contributor ids; a
    // single query then fetches those contributors. Rendering iterates the same
    // `page`, so the prefetched set can't drift from the rendered rows.
    const page: typeof subs = [];
    const pageIds = new Set<number>();
    let budget = 0;
    for (const row of remaining) {
      const cost = isMediaSubmission(row.sub.type) ? 2 : 1;
      if (budget + cost > LIST_PAGE) break;
      budget += cost;
      page.push(row);
      pageIds.add(row.app.contributor_id);
    }
    const contributorsById = new Map((await listContributorsByIds([...pageIds])).map((c) => [c.telegram_id, c]));
    // These are synchronous replies (not queued) so the reviewer sees the cards
    // at once — they bypass the global rate limiter, which the LIST_PAGE message
    // budget keeps within Telegram's per-chat limit. If a card send fails anyway
    // (e.g. a 429), stop the listing but fall through to the remainder notice so
    // the reviewer learns more work is queued rather than silently seeing a
    // truncated list (an unhandled throw here would abort with no notice).
    let shown = 0;
    for (const { sub, app, task } of page) {
      try {
        await ctx.reply(submissionReviewCard(sub, app, task, contributorsById.get(app.contributor_id)), reviewButtons(sub, L));
      } catch (err) {
        console.error('[review] card send failed, stopping listing:', err instanceof Error ? err.message : err);
        break;
      }
      try {
        await sendSubmissionAttachment(ctx.telegram, ctx.chat!.id, sub, L);
      } catch {
        // The reviewer must know an attachment exists but didn't load — a
        // silent miss here would mean deciding on work they never saw.
        await ctx.reply(t(L, 'review.attachFail')).catch(() => undefined);
      }
      shown += 1;
    }
    if (shown < remaining.length) {
      // A failed card send leaves shown short (possibly 0) — the button then
      // carries the last id actually shown, so the next tap retries from there.
      const lastId = shown > 0 ? page[shown - 1].sub.id : afterId;
      const position = subs.length - remaining.length + shown;
      await ctx
        .reply(t(L, 'review.more', { shown: position, total: subs.length }), reviewNextButton(lastId, L))
        .catch(() => undefined);
    }
  }

  bot.command('review', async (ctx) => {
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    await sendReviewPage(ctx, localeOf(ctx), scope, 0);
  });

  // The Next-page button under a review page: re-checks management (the reviewer
  // may have been demoted since) and sends the page after the anchored id.
  bot.action(/^rev:more:(\d+)$/, async (ctx) => {
    // Review cards are DM-only; from a group this is a forged callback that
    // would dump submissions + contributor stats into the group.
    if (!(await requirePrivateCb(ctx))) return;
    const L = localeOf(ctx);
    const scope = await resolveScope(ctx.from?.id);
    if (!scope) return void safeAnswerCb(ctx, t(L, 'common.adminsOnly'), { show_alert: true });
    await safeAnswerCb(ctx);
    await sendReviewPage(ctx, L, scope, Number(ctx.match[1]));
  });

  // ---- Close / reopen (admin) ----
  bot.command('close', (ctx) =>
    adminTaskCommand(
      ctx,
      // The close and its applicant notices commit together (withTransaction
      // nests, so closeTask joins this transaction): applicants whose
      // applications the close just orphaned hear about it — apply and assign
      // both require an Open task, so without the notice they wait on nothing.
      (taskId, adminId) =>
        withTransaction(async () => {
          const task = await closeTask(taskId, adminId);
          await notifyApplicantsTaskChanged(task, 'closed');
          return task;
        }),
      'close.usage',
      'close.ok',
      'task.closeFail',
    ),
  );
  bot.command('reopen', (ctx) =>
    adminTaskCommand(ctx, reopenTask, 'reopen.usage', 'reopen.ok', 'task.reopenFail'),
  );

  async function adminTaskCommand(
    ctx: BotContext,
    mutate: (taskId: number, adminId: number) => Promise<{ id: number }>,
    usageKey: 'close.usage' | 'reopen.usage',
    okKey: 'close.ok' | 'reopen.ok',
    failKey: 'task.closeFail' | 'task.reopenFail',
  ): Promise<void> {
    const L = localeOf(ctx);
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    const id = parseId(commandArg(ctx));
    if (id === null) {
      await ctx.reply(t(L, usageKey));
      return;
    }
    const task = await getTask(id);
    if (!task || !inScope(scope, task)) {
      await ctx.reply(t(L, 'task.notManageable', { id }));
      return;
    }
    try {
      const updated = await mutate(id, ctx.from!.id);
      await ctx.reply(t(L, okKey, { id: updated.id }));
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, failKey)));
    }
  }

  // ---- Unassign (manager) — reason captured in a scene ----
  bot.command('unassign', async (ctx) => {
    const L = localeOf(ctx);
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'unassign.usage'));
    const app = await getApplication(id);
    if (!app || !inScope(scope, await getTask(app.task_id))) {
      return ctx.reply(t(L, 'app.notManageable', { id }));
    }
    return ctx.scene.enter(SCENES.unassign, { applicationId: id });
  });

  // ---- Erasure (admin) ----
  bot.command('forget', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'forget.usage'));
    try {
      await forgetContributor(id, ctx.from!.id);
      // Drop the profile-dedup cache entry: the row is gone, so the erased user's
      // next private update must re-run upsertContributor to re-create it. Leaving
      // a stale key here would make the middleware skip the re-registration and
      // strand them (apply()'s just-erased guard would fire forever).
      profileSeen.delete(id);
      await ctx.reply(t(L, 'forget.ok', { id }));
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'forget.fail')));
    }
  });

  // ---- Self-serve erasure REQUEST (contributor) ----
  // /forgetme files the request with the operators; the erasure itself stays a
  // human-run /forget behind the money-in-flight guard. Without this, the
  // /privacy promise ends in "find and petition an admin out-of-band" — the
  // person who wants their data gone had no in-product way to ask. A confirm
  // button gates it: consequential enough that a lone typed command (or a
  // mis-tap of a suggested command) shouldn't file it.
  bot.command('forgetme', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    await ctx.reply(
      t(L, 'forgetme.confirm'),
      Markup.inlineKeyboard([[Markup.button.callback(t(L, 'btn.forgetme'), 'forgetme:yes')]]),
    );
  });
  bot.action(/^forgetme:yes$/, (ctx) =>
    callbackMutation(
      ctx,
      // DM-gated like the command: forged onto a group message, the card edit
      // would broadcast someone's erasure request to the room.
      requirePrivateCb,
      async () => ({ uid: ctx.from!.id, username: ctx.from!.username ?? null }),
      async ({ uid, username }, L) => ({
        enqueue: () => notifyErasureRequest(uid, username),
        popup: t(L, 'forgetme.popup'),
        card: t(L, 'forgetme.requested'),
      }),
    ),
  );

  // Optional DAO-push payout (gated on DAO_CONTRACT_ID; dormant otherwise). Proposes
  // a NEAR Transfer for a task's pending payout through the bot's OutLayer TEE
  // wallet — the ONLY proposer path (the old printed near-cli fallback was a
  // replayable out-of-band command, the root of the duplicate-proposal hazard;
  // without OutLayer, proposePayout refuses with guidance). This ONLY
  // proposes — a human DAO Approver must vote to release the funds.
  // Usage: /pay <taskId> <amountNEAR> <recipient.near>
  bot.command('pay', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    if (!config.daoContractId) return ctx.reply(t(L, 'pay.notEnabled'));
    const [, taskArg, amountArg, accountArg] = (messageText(ctx) ?? '').split(/\s+/);
    const taskId = parseId(taskArg);
    if (taskId === null || !amountArg) return ctx.reply(t(L, 'pay.usage'));
    const yocto = parseNearToYocto(amountArg);
    if (!yocto) return ctx.reply(t(L, 'pay.badAmount'));
    const payout = await singleTaskPayout(ctx, L, taskId);
    if (!payout) return;
    const account = accountArg || (await getPayoutAccount(payout.contributor_id));
    if (!account) return ctx.reply(t(L, 'pay.noRecipient', { taskId, amount: amountArg }));
    try {
      // An invalid/over-long account never echoes: proposePayout format-checks it
      // (assertPayableAccount) before any message interpolates it.
      const res = await proposePayout(payout.id, account, yocto);
      if ('proposalId' in res) {
        // Echo the advertised (free-text) reward next to the proposed amount:
        // the admin resolves "50 USDC" to NEAR by hand, and the approver's
        // verify-before-vote is the only control after this line.
        await ctx.reply(
          t(L, 'pay.proposed', {
            taskId,
            amount: amountArg,
            account,
            reward: payout.reward,
            proposalId: res.proposalId,
            url: proposalUrl(res.proposalId),
          }),
        );
      } else {
        // Submitted, but the gateway's proposal id didn't verify — don't print an
        // id we can't trust; reconcile adopts the real one by description.
        await ctx.reply(t(L, 'pay.submitted', { taskId, amount: amountArg, account, reward: payout.reward }));
      }
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'pay.fail')));
    }
  });

  // Contributor sets/views their standing DAO-push payout account (gated on
  // DAO_CONTRACT_ID). Typed, not proof-backed — validated to exist on-chain.
  // Usage: /payto <your.near>
  bot.command('payto', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateChat(ctx, 'common.privateOnly'))) return;
    if (!config.daoContractId) return ctx.reply(t(L, 'payto.notEnabled'));
    const account = commandArg(ctx);
    // Disclose the on-chain-permanence consequence at the moment of setting (the
    // prompt) AND on success — the same disclosure contract the Mini App and
    // /privacy honor (payto.disclosure): a payout publishes this account + task
    // id on the public chain, forever, beyond /forget.
    if (!account) {
      const current = await getPayoutAccount(ctx.from!.id);
      const line = current ? t(L, 'payto.current', { account: current }) : t(L, 'payto.prompt');
      return ctx.reply(`${line}\n${t(L, 'payto.disclosure')}`);
    }
    try {
      await setPayoutAccount(ctx.from!.id, account);
      await ctx.reply(`${t(L, 'payto.ok', { account })}\n${t(L, 'payto.disclosure')}`);
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'payto.fail')));
    }
  });

  // ---- Task status & history ----
  bot.command('status', async (ctx) => {
    const L = localeOf(ctx);
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'status.usage'));
    const task = await getTask(id);
    const uid = ctx.from!.id;
    const dm = ctx.chat?.type === 'private';
    // Manager visibility (drafts, everyone's history — pitches, names, notes)
    // is DM-only: /status is a public command that groups deliver too, and an
    // admin typing it there must not dump contributor data into the group.
    // Room admins get the same view for their rooms' tasks — they review that
    // work anyway.
    const admin = dm && (await canManageTask(uid, task));
    // The service visibility floor (isTaskPublic: drafts are never public),
    // widened for managers and for applicants who engaged with the task.
    const authorized = task && (admin || isTaskPublic(task) || !!(await getApplicationFor(id, uid)));
    if (!task || !authorized) return ctx.reply(t(L, 'status.notVisible', { id }));
    const entries = await listHistory(id);
    // In a group, even the invoker's OWN events stay hidden — their rendered
    // details (a pitch, a review note about their work) would land in the
    // group. Task-level actions name no contributor and are safe anywhere.
    const visible = admin
      ? entries
      : entries.filter(
          (e) => TASK_LEVEL_ACTIONS.has(e.action) || (dm && (e.actor_id === uid || e.subject_id === uid)),
        );
    // On a busy task, keep the NEWEST events — "what just happened" is what
    // /status is for. The tail slice says so; chunkMessage (not clampMessage)
    // guarantees nothing that made the cut is silently truncated.
    const recent = visible.slice(-HISTORY_PAGE);
    const omitted =
      visible.length > recent.length
        ? `${t(L, 'status.moreHistory', { shown: recent.length, total: visible.length })}\n`
        : '';
    // Resolve each distinct actor once so historyBlock stays pure (no DB reads).
    const actorIds = [...new Set(recent.map((e) => e.actor_id).filter((x): x is number => x != null))];
    const actorsById = new Map((await listContributorsByIds(actorIds)).map((c) => [c.telegram_id, c]));
    const labels = new Map(
      actorIds.map((aid) => {
        const c = actorsById.get(aid);
        return [aid, who(aid, c)] as const;
      }),
    );
    const slots = await countSlotsTaken(id);
    const text = `${taskDetail(task, slots)}\n\n🕓 History:\n${omitted}${historyBlock(recent, labels)}`;
    for (const part of chunkMessage(text)) await ctx.reply(part);
  });

  // ---- Callback actions ----
  bot.action(/^apply:(\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    await ctx.scene.enter(SCENES.apply, { taskId: Number(ctx.match[1]) });
  });

  bot.action(/^approve:(\d+)$/, (ctx) =>
    callbackMutation(
      ctx,
      requireManageCb(() => getTask(Number(ctx.match[1]))),
      // The announcement rows commit WITH the approval (callbackMutation's
      // shared transaction), because once a task is Open no path would ever
      // announce it again — a lost enqueue would be permanent. A failure rolls
      // the approval back, so the admin can simply tap Approve again. Approval
      // still doesn't wait on Telegram: the background worker delivers the
      // channel post and opt-in DMs after commit, globally rate-limited. The
      // launch-scale audience read + row build run BEFORE approveTask so the
      // task lock never spans the whole fan-out build — only the enqueue does.
      async () => {
        const taskId = Number(ctx.match[1]);
        const draft = await getTask(taskId);
        const rows = draft ? await buildAnnounceRows(draft) : [];
        const task = await approveTask(taskId, ctx.from!.id);
        await enqueueAnnounceRows(rows);
        return task;
      },
      async (task, L) => ({
        popup: t(L, 'approve.popup'),
        card: t(L, 'approve.opened', { detail: taskDetail(task, 0) }),
      }),
    ),
  );

  // The draft's other exit: delete it. Without this, the only way to clear a
  // junk auto-draft from /approve is to PUBLISH it — announcing exactly the
  // distilled group chatter the admin is rejecting (see discardDraft).
  bot.action(/^discard:(\d+)$/, (ctx) =>
    callbackMutation(
      ctx,
      requireManageCb(() => getTask(Number(ctx.match[1]))),
      () => discardDraft(Number(ctx.match[1]), ctx.from!.id),
      async (task, L) => ({
        popup: t(L, 'approve.discardPopup'),
        card: t(L, 'approve.discarded', { id: task.id }),
      }),
    ),
  );

  // Task resolution for application/submission cards: the manage gate needs the
  // task behind the id on the button.
  const taskOfApplication = async (applicationId: number): Promise<Task | undefined> => {
    const app = await getApplication(applicationId);
    return app ? getTask(app.task_id) : undefined;
  };
  const taskOfSubmission = async (submissionId: number): Promise<Task | undefined> => {
    const sub = await getSubmission(submissionId);
    return sub ? taskOfApplication(sub.application_id) : undefined;
  };

  bot.action(/^assign:(\d+)$/, (ctx) =>
    callbackMutation(
      ctx,
      requireManageCb(() => taskOfApplication(Number(ctx.match[1]))),
      () => assignApplication(Number(ctx.match[1]), ctx.from!.id),
      async ({ application, task, filled }, L) => ({
        enqueue: async () => {
          await notifyApplicant(application, task, 'assigned');
          // The last slot just went — the rest of the pool hears their wait
          // changed shape instead of silently watching a full task.
          if (filled && task) await notifyApplicantsTaskChanged(task, 'filled', application.id);
        },
        popup: t(L, 'assign.popup'),
        card: t(L, 'assign.ok', { taskId: application.task_id }),
      }),
    ),
  );

  bot.action(/^decline:(\d+)$/, (ctx) =>
    callbackMutation(
      ctx,
      requireManageCb(() => taskOfApplication(Number(ctx.match[1]))),
      () => declineApplication(Number(ctx.match[1]), ctx.from!.id),
      async ({ application, task }, L) => ({
        enqueue: async () => notifyApplicant(application, task, 'declined'),
        popup: t(L, 'decline.popup'),
        card: t(L, 'decline.ok', { taskId: application.task_id }),
      }),
    ),
  );

  bot.action(/^submit:(\d+)$/, async (ctx) => {
    await safeAnswerCb(ctx);
    await ctx.scene.enter(SCENES.submit, { applicationId: Number(ctx.match[1]) });
  });

  // Ownership is enforced by withdrawApplication itself; the private-chat gate
  // is for the card edit — a withdraw callback forged onto a group message
  // would otherwise rewrite that shared message into a personal confirmation.
  bot.action(/^withdraw:(\d+)$/, (ctx) =>
    callbackMutation(
      ctx,
      requirePrivateCb,
      () => withdrawApplication(Number(ctx.match[1]), ctx.from!.id),
      async (app, L) => ({
        // no enqueue: withdrawing notifies no one today
        popup: t(L, 'withdraw.popup'),
        card: t(L, 'withdraw.ok', { taskId: app.task_id }),
      }),
    ),
  );

  // Full submission content on demand: cards clip long text to stay compact,
  // but the decision surface must let the reviewer read every character.
  // Inbound Telegram text is ≤4096 chars, so this is one message today;
  // chunkMessage guards any future ingestion path that stores more.
  bot.action(/^full:(\d+)$/, async (ctx) => {
    // Full-submission dumps are DM-only, like the review cards that carry the
    // button — a group-side tap is forged and would post the work publicly.
    if (!(await requirePrivateCb(ctx))) return;
    if (!(await requireManageCb(() => taskOfSubmission(Number(ctx.match[1])))(ctx))) return;
    const L = localeOf(ctx);
    const sub = await getSubmission(Number(ctx.match[1]));
    if (!sub) return safeAnswerCb(ctx, t(L, 'full.gone'), { show_alert: true });
    await safeAnswerCb(ctx);
    for (const part of chunkMessage(fullSubmissionText(sub))) await ctx.reply(part);
  });

  bot.action(/^rev:(approve|reject|revise):(\d+)$/, async (ctx) => {
    const decision = ctx.match[1] as 'approve' | 'reject' | 'revise';
    const submissionId = Number(ctx.match[2]);
    const gate = requireManageCb(() => taskOfSubmission(submissionId));
    // Approve decides immediately; reject/revise first collect a note in a scene.
    if (decision === 'approve') {
      return callbackMutation(
        ctx,
        gate,
        () => reviewSubmission(submissionId, ctx.from!.id, 'approve', null),
        async ({ submission, application, task }, L) => ({
          enqueue: async () =>
            notifyContributorReview(submission.id, application.contributor_id, task, 'approve', null),
          popup: t(L, 'reviewAction.popup'),
          card: t(L, 'reviewAction.approved', { id: submissionId }),
        }),
      );
    }
    if (!(await gate(ctx))) return;
    await safeAnswerCb(ctx);
    await ctx.scene.enter(SCENES.review, { submissionId, decision });
  });

  // ---- Rooms (group chats) & signal detection ----

  /** Group-only gate: the room commands act on "this group" and mean nothing in a DM. */
  async function requireGroupCmd(ctx: BotContext): Promise<boolean> {
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') return true;
    await ctx.reply(t(localeOf(ctx), 'rooms.groupOnly'));
    return false;
  }

  const canManageRoom = async (userId: number | undefined, chatId: number): Promise<boolean> =>
    isAdmin(userId) || (userId !== undefined && (await isRoomAdmin(chatId, userId)));

  const chatTitle = (ctx: BotContext): string | null =>
    ctx.chat && 'title' in ctx.chat ? ctx.chat.title ?? null : null;

  // The two room features share one toggle shape — each feature's service
  // setter, AI precondition, and notice keys live in exactly one row here, so
  // the /settings taps and the classic commands (/enablesignals, /ai on|off)
  // can't drift (the panel once showed the signals precondition for the AI
  // toggle). Both features need AI assistance to turn ON; OFF always works.
  const ROOM_FEATURES = {
    sig: { set: setRoomSignals, needsAi: 'signals.needsAi', on: 'signals.enabled', off: 'signals.disabled' },
    ai: { set: setRoomAi, needsAi: 'ai.needsAi', on: 'ai.on', off: 'ai.off' },
  } as const;

  /** Toggle one room feature. Returns the locale key to show: on success the
   *  group-visible transparency notice (members are entitled to see scanning /
   *  answering switch), on refusal the feature's AI-precondition message. */
  async function toggleRoomFeature(
    chatId: number,
    feature: keyof typeof ROOM_FEATURES,
    on: boolean,
  ): Promise<{ ok: boolean; key: 'signals.needsAi' | 'ai.needsAi' | 'signals.enabled' | 'signals.disabled' | 'ai.on' | 'ai.off' }> {
    const f = ROOM_FEATURES[feature];
    if (on && !ai.aiEnabled()) return { ok: false, key: f.needsAi };
    await f.set(chatId, on);
    return { ok: true, key: on ? f.on : f.off };
  }

  /**
   * Why an enabled feature might still hear nothing: under Telegram's default
   * privacy mode a bot in a group receives commands and replies but NOT plain
   * member messages — signal detection never fires and AI-mode mentions go
   * unseen, with no error or log anywhere (the listener simply never runs).
   * Detectable: getMe's can_read_all_group_messages is false AND the bot is not
   * an admin of THIS chat (group admins receive everything regardless). Returns
   * the warning to append to an enable confirmation, or null when member
   * messages actually reach the bot.
   */
  async function groupReceiveWarning(ctx: BotContext, L: string): Promise<string | null> {
    if (ctx.botInfo?.can_read_all_group_messages) return null;
    try {
      const me = await ctx.telegram.getChatMember(ctx.chat!.id, ctx.botInfo.id);
      if (me.status === 'administrator') return null;
    } catch {
      // Can't verify — warn anyway: a spurious hint beats a silently dead feature.
    }
    return t(L, 'rooms.receiveWarning');
  }

  /** An enable confirmation, with the receive warning appended when it applies. */
  async function toggleReply(
    ctx: BotContext,
    L: string,
    r: Awaited<ReturnType<typeof toggleRoomFeature>>,
    on: boolean,
  ): Promise<string> {
    const warn = r.ok && on ? await groupReceiveWarning(ctx, L) : null;
    return warn ? `${t(L, r.key)}\n\n${warn}` : t(L, r.key);
  }

  // ---- /settings: one editable panel folding the room + notification toggles ----
  // In a group it exposes the room-admin toggles (signal detection, AI mode);
  // in a DM it exposes the contributor's task-announcement opt-in. Like
  // /signalstatus and /ai status the read-only panel is public — authorization
  // is enforced on the TAP (a non-manager tapping a room toggle gets an alert).
  // The callback carries no chat id: a toggle acts on the chat the panel lives
  // in (the room, or the tapper's own DM). The classic commands still work; this
  // just collapses /enablesignals + /disablesignals + /ai + /notify into taps.
  async function settingsPanel(ctx: BotContext, L: string): Promise<PageView> {
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
      const room = await getRoom(ctx.chat.id);
      const sigOn = room?.signals_enabled === 1;
      const aiOn = room?.ai_enabled === 1;
      const counts = room ? await signalCountsForRoom(room.chat_id) : { drafted: 0, discarded: 0 };
      return {
        text: [
          t(L, 'settings.groupHeader'),
          t(L, 'settings.signalsLine', { on: sigOn, ...counts }),
          t(L, 'settings.aiLine', { on: aiOn }),
        ].join('\n'),
        rows: [
          [Markup.button.callback(t(L, sigOn ? 'btn.signalsOff' : 'btn.signalsOn'), `set:sig:${sigOn ? 'off' : 'on'}`)],
          [Markup.button.callback(t(L, aiOn ? 'btn.aiModeOff' : 'btn.aiModeOn'), `set:ai:${aiOn ? 'off' : 'on'}`)],
        ],
      };
    }
    const on = (await getContributor(ctx.from!.id))?.announce_opt_in === 1;
    return {
      text: t(L, 'settings.notifyLine', { on }),
      rows: [[Markup.button.callback(t(L, on ? 'btn.notifyOff' : 'btn.notifyOn'), `set:notify:${on ? 'off' : 'on'}`)]],
    };
  }

  bot.command('settings', async (ctx) => {
    await sendPage(ctx, await settingsPanel(ctx, localeOf(ctx)));
  });

  bot.action(/^set:(sig|ai|notify):(on|off)$/, async (ctx) => {
    // Host provenance, same class-match rule as the pg: pager: act only when
    // the host message actually carries settings buttons (the /settings panel
    // or the /ai status card). Forged set: data on any other bot message —
    // say, the shared task announcement — would otherwise apply the toggle and
    // then editPage that message into the settings panel, destroying its Apply
    // button for the whole room. Class-match, not exact: the panel's buttons
    // flip between on/off states under concurrent taps.
    if (!hostButtonData(ctx).some((d) => d.startsWith('set:'))) return void safeAnswerCb(ctx);
    const what = ctx.match[1];
    const on = ctx.match[2] === 'on';
    const L = localeOf(ctx);
    // Set when a room toggle succeeds: the group notice members deserve for a
    // scanning change. Sent AFTER the callback is answered — the toggle has
    // already been applied by then, and a bot muted in its own group must not
    // leave the tapper's spinner hanging on the un-postable notice.
    let groupNotice: (() => Promise<unknown>) | null = null;
    // A throw anywhere in the mutation must still answer the callback (as an
    // error popup) — the same contract pg: and callbackMutation hold.
    try {
      if (what === 'notify') {
        // The tapper's own setting — no ROLE gate needed, but callback data is
        // client-tamperable, so gate the CHAT TYPE like the other DM-only
        // callbacks: a forged set:notify referencing a group message would
        // otherwise editPage a shared announcement into a settings panel.
        if (!(await requirePrivateCb(ctx))) return;
        await setAnnounceOptIn(ctx.from!.id, on);
      } else {
        // Room toggles are manager-only, enforced HERE since the panel is public.
        const chatId = ctx.chat?.id;
        if (chatId === undefined || !(await canManageRoom(ctx.from?.id, chatId))) {
          return void safeAnswerCb(ctx, t(L, 'rooms.roomAdminsOnly'), { show_alert: true });
        }
        // Self-heal the room row (legacy groups) before toggling, like the
        // commands' gate does — a benign upsert, already manager-gated above.
        await registerRoom(chatId, chatTitle(ctx), null);
        const r = await toggleRoomFeature(chatId, what as 'sig' | 'ai', on);
        if (!r.ok) return void safeAnswerCb(ctx, t(L, r.key), { show_alert: true });
        const notice = await toggleReply(ctx, L, r, on);
        groupNotice = () => ctx.reply(notice);
      }
    } catch (err) {
      return void answerCbError(ctx, L, err);
    }
    await safeAnswerCb(ctx);
    // The notice send is exactly what a send-restricted bot can't do — swallow
    // its failure so the panel refresh below still reflects the applied toggle
    // (a stale panel would offer the same action again, silently undoing it).
    if (groupNotice) await groupNotice().catch(() => undefined);
    await editPage(ctx, await settingsPanel(ctx, L));
  });

  /**
   * Check the caller first, THEN self-heal: an unauthorized member must not be
   * able to drive a room write (upsert + updated_at bump) just by invoking a
   * command they can't use — canManageRoom is a config check plus at most one
   * read, so refusing costs nothing. Only an authorized caller reaches
   * registerRoom, which ensures the row exists (the bot may predate this feature
   * in the group, so my_chat_member never fired) and refreshes its title. A
   * legacy room starts with no admins, so isRoomAdmin is false for everyone —
   * only a global admin (isAdmin, no row needed) passes and bootstraps it.
   */
  async function requireRoomManagerCmd(ctx: BotContext): Promise<boolean> {
    const chatId = ctx.chat!.id;
    if (!(await canManageRoom(ctx.from?.id, chatId))) {
      await ctx.reply(t(localeOf(ctx), 'rooms.roomAdminsOnly'));
      return false;
    }
    await registerRoom(chatId, chatTitle(ctx), null);
    return true;
  }

  // Fires when the bot's own membership changes — the room bootstrap: whoever
  // added the bot becomes the room's first admin (a practical, trusted default;
  // without it only global admins could set a room up), and global admins are
  // told where the bot landed.
  bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    const chat = upd.chat;
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    const JOINED = ['member', 'administrator'];
    const LEFT = ['left', 'kicked'];
    const was = upd.old_chat_member.status;
    const now = upd.new_chat_member.status;
    if (LEFT.includes(was) && JOINED.includes(now)) {
      const inviterId = upd.from.is_bot ? null : upd.from.id;
      const { inviterBecameAdmin } = await registerRoom(chat.id, chat.title ?? null, inviterId);
      await notifyRoomRegistered(chat.id, chat.title ?? null, inviterId, upd.date);
      // The join must not be silent: greet the group with what the bot does and
      // where to switch it on, and DM the inviter that they are now this room's
      // first admin (previously nobody ever told them — the room bootstrap was
      // invisible without reading the README). Both queued and best-effort; the
      // DM 403s harmlessly if the inviter never started the bot.
      await notifyRoomWelcome(chat.id, upd.date);
      if (inviterBecameAdmin && inviterId !== null) {
        await notifyRoomAdminPromoted(inviterId, chat.id, chat.title ?? null, upd.date);
      }
    } else if (JOINED.includes(was) && LEFT.includes(now)) {
      // Kicked/left: stop scanning AND stop answering. The room row and its
      // admins stay — they are provenance for existing tasks, and re-adding the
      // bot restores them (but not the toggles, which need a fresh opt-in).
      try {
        await setRoomSignals(chat.id, false);
        await setRoomAi(chat.id, false);
      } catch (err) {
        // Only the missing-room case is benign (bot was added before rooms
        // existed — nothing to switch off). Anything else must surface in
        // bot.catch: swallowing a transient DB error here would leave
        // signals_enabled=1, and scanning would silently resume when the bot
        // is re-added, without a fresh /enablesignals.
        if (!(err instanceof WorkflowError)) throw err;
      }
    }
  });

  // A group upgraded to a supergroup gets a NEW chat id, announced only by a
  // service message on each side of the rename (my_chat_member does not fire —
  // the bot's membership never changed). Everything keyed by chat id must
  // follow, or the room silently goes dark and its admins are locked out (the
  // manager gate keys off the room row they'd need to re-create). Both sides
  // funnel into the same idempotent rewrite; whichever update arrives first
  // does the work and the other finds nothing left to move.
  // On failure, log BOTH ids before rethrowing to bot.catch: the service
  // messages are consumed either way, so this breadcrumb is what makes a
  // stranded room manually recoverable from the logs.
  const runMigration = async (oldId: number, newId: number): Promise<void> => {
    try {
      await migrateRoomChat(oldId, newId);
    } catch (err) {
      console.error(`[rooms] MIGRATION FAILED ${oldId} → ${newId}:`, err instanceof Error ? err.message : err);
      throw err;
    }
  };
  bot.on(message('migrate_to_chat_id'), async (ctx) => {
    console.log(`[rooms] group ${ctx.chat.id} upgraded to supergroup ${ctx.message.migrate_to_chat_id}`);
    await runMigration(ctx.chat.id, ctx.message.migrate_to_chat_id);
  });
  bot.on(message('migrate_from_chat_id'), async (ctx) => {
    await runMigration(ctx.message.migrate_from_chat_id, ctx.chat.id);
  });

  bot.command('enablesignals', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx)) || !(await requireRoomManagerCmd(ctx))) return;
    // The success reply lands in the group — deliberate: it is the members'
    // notice that their messages are now AI-scored (and that nothing is stored).
    const r = await toggleRoomFeature(ctx.chat!.id, 'sig', true);
    return ctx.reply(await toggleReply(ctx, L, r, true));
  });

  bot.command('disablesignals', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx)) || !(await requireRoomManagerCmd(ctx))) return;
    const r = await toggleRoomFeature(ctx.chat!.id, 'sig', false);
    return ctx.reply(t(L, r.key));
  });

  // Public on purpose: whether this group is being scanned is exactly the thing
  // every member is entitled to check. Counts are anonymous by construction.
  bot.command('signalstatus', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx))) return;
    const room = await getRoom(ctx.chat!.id);
    const on = room?.signals_enabled === 1;
    const counts = room ? await signalCountsForRoom(room.chat_id) : { drafted: 0, discarded: 0 };
    return ctx.reply(t(L, 'signals.status', { on, ...counts }));
  });

  // Conversational AI mode: /ai on|off (room admin) or /ai status (anyone).
  // Status is public like /signalstatus — whether the bot is answering here is
  // something every member is entitled to know.
  bot.command('ai', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx))) return;
    const arg = commandArg(ctx)?.toLowerCase();
    if (arg === 'status' || arg === undefined) {
      // Tapping /ai from the group command menu sends the BARE command (menus
      // can't carry arguments), so this status reply is the only thing a
      // menu-tapper ever reaches — carry the toggle button (same manager-gated
      // set:ai callback as /settings) or the menu path can never enable AI mode.
      const room = await getRoom(ctx.chat!.id);
      const on = room?.ai_enabled === 1;
      return ctx.reply(
        t(L, 'ai.status', { on }),
        Markup.inlineKeyboard([
          [Markup.button.callback(t(L, on ? 'btn.aiModeOff' : 'btn.aiModeOn'), `set:ai:${on ? 'off' : 'on'}`)],
        ]),
      );
    }
    if (arg !== 'on' && arg !== 'off') return ctx.reply(t(L, 'ai.usage'));
    if (!(await requireRoomManagerCmd(ctx))) return;
    const r = await toggleRoomFeature(ctx.chat!.id, 'ai', arg === 'on');
    return ctx.reply(await toggleReply(ctx, L, r, arg === 'on'));
  });

  /** The replied-to user on a /addroomadmin- or /removeroomadmin-style command, or null. */
  function repliedUser(ctx: BotContext): { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string } | null {
    const msg = ctx.message;
    if (!msg || !('reply_to_message' in msg)) return null;
    return msg.reply_to_message?.from ?? null;
  }

  const userLabel = (u: { id: number; first_name?: string; last_name?: string; username?: string }): string =>
    displayName(u) || (u.username ? `@${u.username}` : String(u.id));

  // Telegram bots can't resolve @username → user id, so promoting someone
  // requires replying to one of their messages (the standard workaround: the
  // reply carries their real numeric id).
  bot.command('addroomadmin', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx)) || !(await requireRoomManagerCmd(ctx))) return;
    const target = repliedUser(ctx);
    if (!target) return ctx.reply(t(L, 'rooms.replyToAdd'));
    if (target.is_bot) return ctx.reply(t(L, 'rooms.botCannotBeAdmin'));
    const chatId = ctx.chat!.id;
    const added = await addRoomAdmin(chatId, target.id);
    const name = userLabel(target);
    if (!added) return ctx.reply(t(L, 'rooms.alreadyAdmin', { name }));
    // Best-effort DM (they may never have started the bot); the group reply is
    // the authoritative confirmation. message_id keys the dedup to this command.
    const msgId = ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0;
    await notifyRoomAdminPromoted(target.id, chatId, chatTitle(ctx), msgId);
    return ctx.reply(t(L, 'rooms.adminAdded', { name }));
  });

  bot.command('removeroomadmin', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx)) || !(await requireRoomManagerCmd(ctx))) return;
    const target = repliedUser(ctx);
    if (!target) return ctx.reply(t(L, 'rooms.replyToRemove'));
    const name = userLabel(target);
    const removed = await removeRoomAdmin(ctx.chat!.id, target.id);
    return ctx.reply(t(L, removed ? 'rooms.adminRemoved' : 'rooms.notAdmin', { name }));
  });

  // Public like /signalstatus: who can manage this group's tasks is group-local
  // knowledge (these people are visible members acting on its behalf).
  bot.command('roomadmins', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx))) return;
    // Read-only, like /signalstatus: listRoomAdmins returns [] for a room with no
    // row, so a registered admin set is a precondition, not something to create —
    // don't write (upsert + updated_at bump) on every invocation of a public read.
    const admins = await listRoomAdmins(ctx.chat!.id);
    if (admins.length === 0) return ctx.reply(t(L, 'rooms.noAdmins'));
    const adminsById = new Map((await listContributorsByIds(admins)).map((c) => [c.telegram_id, c]));
    const lines = admins
      .map((uid) => {
        const c = adminsById.get(uid);
        return `• ${who(uid, c)}`;
      })
      .join('\n');
    return ctx.reply(clampMessage(t(L, 'rooms.adminList', { lines })));
  });

  // Fallback text listener — LAST on purpose, after every command: in a room
  // that opted in via /enablesignals (and only there), plain group messages
  // feed signal detection. Requires the bot to actually receive group texts:
  // either privacy mode off, or the bot promoted to admin in that group.
  bot.on('text', (ctx) => {
    // A DM reaching this catch-all matched nothing: no command handler took it
    // and no wizard is active (a live scene consumes its updates upstream). The
    // common real case is a pitch or submission typed after a redeploy dropped
    // the RAM-only wizard session — silence there reads as a broken bot, so
    // point back at the entry points. (Also catches typo'd commands.)
    if (ctx.chat?.type === 'private') {
      return void ctx.reply(t(localeOf(ctx), 'common.dmLost'));
    }
    if (ctx.chat?.type !== 'group' && ctx.chat?.type !== 'supergroup') return;
    if (ctx.from?.is_bot) return;
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // commands are neither conversation nor signals
    // Free bot-wide gate before any DB or detached work: with no API key,
    // neither the agent nor signal detection can run, so there is nothing to
    // route (restores the "free gates first" invariant the old handler had).
    if (!ai.aiEnabled()) return;
    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    // A message directed at the bot (in an AI-mode room) goes to the agent;
    // everything else is ambient chatter for signal detection. The two compose.
    const addressed = addressesBot(ctx);
    // Detached AND drain-tracked from the first await: an agent turn or a signal
    // budget claim caught mid-flight by shutdown must unwind cleanly (the abort
    // signal), not strand work.
    runDetached('group-text', async (signal) => {
      // Only an addressed message can reach the agent, and only that path needs
      // the room's AI-mode flag — so getRoom runs here just for addressed
      // messages, not on every line of ambient chatter. Ambient text goes
      // straight to handleGroupMessage, whose own free gates (prefilter, opt-in)
      // run before its single getRoom.
      if (addressed && userId !== undefined) {
        const room = await getRoom(chatId);
        if (room?.ai_enabled === 1) {
          // The per-room hourly budget (mirroring the signal path's
          // claimSignalSlot) is claimed BEFORE any model spend. Over budget:
          // one notice per window, then silence — never a reply per spam message.
          const slot = claimAgentSlot(chatId);
          if (!slot.allowed) {
            if (slot.notify) await ctx.reply(t(localeOf(ctx), 'agent.budget'));
            return;
          }
          const env: AgentEnv = {
            userId,
            roomChatId: chatId,
            locale: localeOf(ctx),
            isManager: await canManageRoom(userId, chatId),
            isGroup: true,
            reply: (msg, extra) => ctx.reply(msg, extra as Parameters<typeof ctx.reply>[1]).then(() => undefined),
          };
          await runAgentTurn(chatId, text, env, signal);
          return;
        }
        // Addressed but AI mode is off → fall through to the signal path.
      }
      // Ambient chatter → signal path. handleGroupMessage applies the prefilter,
      // opt-in, context-window recording (consent-gated on the room's opt-in,
      // RAM-only — see signals.ts), and hourly-budget gates.
      await handleGroupMessage(chatId, text, signal);
    });
  });

  // The text fallback above never sees media — Telegram puts a caption, not
  // text, on photo/file/video messages, so they match no handler at all. In a
  // private chat that silence hits the same person the dmLost signpost exists
  // for, in their most likely form: a contributor whose /submit wizard was
  // dropped by a redeploy sending the screenshot itself. Give media the same
  // pointer back to the entry points. (Group media stays unhandled — ambient.)
  bot.on('message', (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    // Service messages aren't something the user "sent" — pinning the bot's own
    // task card must not earn them a "your message got lost" reply.
    const m = ctx.message as unknown as Record<string, unknown>;
    if ('pinned_message' in m || 'message_auto_delete_timer_changed' in m) return;
    return void ctx.reply(t(localeOf(ctx), 'common.dmLost'));
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] error handling ${ctx.updateType}:`, err instanceof Error ? err.message : err);
  });

  return bot;
}

// Registered as the default command menu (everyone sees these).
export const CONTRIBUTOR_COMMANDS: { command: string; description: string }[] = [
  { command: 'open', description: 'Browse open tasks and apply' },
  { command: 'myapps', description: 'Your applications; submit assigned work' },
  { command: 'submit', description: 'Submit work for an assignment' },
  { command: 'withdraw', description: 'Withdraw an application' },
  { command: 'notify', description: 'Turn task-announcement DMs on/off' },
  { command: 'settings', description: 'Your notification settings' },
  { command: 'payto', description: 'Set the NEAR account your payouts go to' },
  { command: 'payouts', description: 'Your payouts — money owed to you (admins: the queue)' },
  { command: 'status', description: 'View a task and its history' },
  { command: 'privacy', description: 'What this bot stores about you' },
  { command: 'terms', description: 'The terms of use, in plain language' },
  { command: 'help', description: 'Show help' },
];

// Registered for group chats (Telegram all_group_chats scope): the room-local
// commands plus the contributor commands that answer in groups. Room-admin
// task management happens in a DM and needs no group menu entry.
export const GROUP_COMMANDS: { command: string; description: string }[] = [
  { command: 'enablesignals', description: 'AI task drafts from this group’s chat (room admin)' },
  { command: 'disablesignals', description: 'Stop scanning this group (room admin)' },
  { command: 'signalstatus', description: 'Is signal detection on here?' },
  { command: 'settings', description: 'Signal detection & AI mode (room admin)' },
  { command: 'ai', description: 'Conversational AI mode: on | off | status (room admin)' },
  { command: 'addroomadmin', description: 'Reply to someone: make them a room admin' },
  { command: 'removeroomadmin', description: 'Reply to a room admin: remove them' },
  { command: 'roomadmins', description: 'List this group’s room admins' },
  { command: 'open', description: 'Browse open tasks' },
  { command: 'status', description: 'View a task and its history' },
  { command: 'privacy', description: 'What this bot stores about you' },
];

// Registered only in admins' chats (Telegram per-chat command scope) — everyone
// else's menu stays free of commands that would only answer "Admins only."
export const ADMIN_COMMANDS: { command: string; description: string }[] = [
  { command: 'admin', description: 'Overview of what needs you (admin)' },
  { command: 'newtask', description: 'Create a task (admin)' },
  { command: 'approve', description: 'Approve draft tasks (admin)' },
  { command: 'applicants', description: 'Review applicants (admin)' },
  { command: 'active', description: 'Assignments in progress (admin)' },
  { command: 'review', description: 'Review submitted work (admin)' },
  { command: 'close', description: 'Stop accepting applications (admin)' },
  { command: 'reopen', description: 'Reopen for applications (admin)' },
  { command: 'unassign', description: 'Remove an assignment (admin)' },
  { command: 'payouts', description: 'Payout settlement queue (admin)' },
  { command: 'pay', description: 'Propose a DAO payout for a task (admin)' },
  { command: 'stats', description: 'Funnel stats — is the loop working? (admin)' },
  { command: 'diag', description: 'Config preflight — is everything wired? (admin)' },
  { command: 'forget', description: 'Erase a contributor’s data (admin)' },
];
