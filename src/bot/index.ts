import { Telegraf, session, Scenes, Markup } from 'telegraf';
import { config, isAdmin } from '../config.js';
import { type BotContext, SCENES, displayName, commandArg, parseId, requirePrivateChat, safeAnswerCb } from './context.js';
import {
  approveTask,
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
  setRoomSignals,
  setRoomAi,
  addRoomAdmin,
  removeRoomAdmin,
  listRoomAdmins,
  isRoomAdmin,
  listRoomsAdministeredBy,
  getRoom,
  signalCountsForRoom,
  isTaskPublic,
  listPayoutsByStatus,
  reconcilePayoutOnChain,
  payableWalletLink,
  submitRefusal,
} from '../core/service.js';
import { allocateCommand, formatNear } from '../near/escrow.js';
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
  esc,
  who,
} from './format.js';
import {
  approveButton,
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
  buildAnnounceRows,
  enqueueAnnounceRows,
  sendSubmissionAttachment,
  notifyRoomRegistered,
  notifyRoomAdminPromoted,
} from './notify.js';
import { handleGroupMessage } from './signals.js';
import { runAgentTurn } from '../ai/agent.js';
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
  });
};

/**
 * Room-aware role check: global admins manage every task; room admins manage
 * the tasks that belong to a room they administer (task.room_chat_id). A task
 * with no room (created via DM) is global-admin-only.
 */
async function canManageTask(userId: number | undefined, task: Pick<Task, 'room_chat_id'> | undefined): Promise<boolean> {
  if (isAdmin(userId)) return true;
  return userId !== undefined && task?.room_chat_id != null && (await isRoomAdmin(task.room_chat_id, userId));
}

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
 */
function addressesBot(ctx: BotContext): boolean {
  const msg = ctx.message;
  if (msg === undefined || !('text' in msg)) return false;
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
 * Shared skeleton for callback buttons that commit one service mutation.
 * It pins three easy-to-drop invariants in one place:
 *  - only the mutation sits inside the try — once it commits, a failure below
 *    must surface in bot.catch, not as a false "Something went wrong";
 *  - the durable follow-up (outcome.enqueue) runs straight after the commit,
 *    before any Telegram send can fail and cost it;
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
  let result: T;
  try {
    result = await mutate();
  } catch (err) {
    await safeAnswerCb(ctx, errorMessage(err, t(L, 'common.somethingWrong')), { show_alert: true });
    return;
  }
  const { enqueue, popup, card } = await outcome(result, L);
  await enqueue?.();
  await safeAnswerCb(ctx, popup);
  await ctx.editMessageText(card).catch(() => undefined);
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
  bot.start(async (ctx) => {
    const match = /^t(\d+)$/.exec(ctx.startPayload ?? '');
    if (match) return ctx.scene.enter(SCENES.apply, { taskId: Number(match[1]) });
    return replyHelp(ctx, await help(ctx));
  });
  bot.help(async (ctx) => replyHelp(ctx, await help(ctx)));

  // Home-menu taps. All targets are DM-only (My work renders the invoker's
  // applications; the paginators/panel are personal), so the menu is only shown
  // in a DM and these re-answer the callback then act in that same private chat.
  bot.action(/^home:(open|myapps|settings|help)$/, async (ctx) => {
    const L = localeOf(ctx);
    await safeAnswerCb(ctx);
    const what = ctx.match[1];
    if (what === 'open') return void (await sendPage(ctx, await openPage(ctx, 0, L)));
    if (what === 'myapps') return void (await showMyApps(ctx, L));
    if (what === 'settings') return void (await sendPage(ctx, await settingsPanel(ctx, L)));
    return void (await ctx.reply(await help(ctx)));
  });

  // Inline mode (@bot <query> from ANY chat): search open tasks and offer each as
  // a shareable teaser carrying an Apply deep link — the way to spread a bounty
  // into other communities without leaving the chat. Also what the /open "Share"
  // button (switch_inline_query) drives. Requires inline mode enabled in BotFather.
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
      title: task.title.slice(0, 100),
      description:
        [
          task.reward ? `🎁 ${task.reward}` : '',
          task.deadline ? `⏳ ${task.deadline}` : '',
          task.max_assignees > 1 ? `👥 ${task.max_assignees}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 100) || 'Open task — tap to share',
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
  bot.command('privacy', (ctx) =>
    ctx.reply(
      t(localeOf(ctx), 'privacy.text', {
        ai: ai.aiEnabled(),
        notifRetentionDays: RETENTION_DAYS,
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

  const navRow = (key: string, arg: number, page: number, total: number): Btn[][] => {
    if (total <= 1) return [];
    const nav: Btn[] = [];
    if (page > 0) nav.push(Markup.button.callback('◀ Prev', `pg:${key}:${arg}:${page - 1}`));
    nav.push(Markup.button.callback(`${page + 1}/${total}`, 'pg:noop'));
    if (page < total - 1) nav.push(Markup.button.callback('Next ▶', `pg:${key}:${arg}:${page + 1}`));
    return [nav];
  };

  // Apply affordance for one open task — placement rule shared with the agent's
  // propose_apply (see applyAffordanceBtn in keyboards.ts).
  const applyButtonFor = (ctx: BotContext, task: Task, L: string): Btn | null =>
    applyAffordanceBtn(task, ctx.chat?.type === 'private', config.botUsername, L);

  async function openPage(ctx: BotContext, page: number, L: string): Promise<PageView> {
    const open = await listOpenTasks();
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
    // Inline queries cap at 256 chars — a raw slice (no ellipsis) keeps the
    // prefilled query a prefix the inline handler's includes() filter still matches.
    action.push(Markup.button.switchToChat(t(L, 'btn.share'), task.title.slice(0, 256)));
    return { text: taskDetail(task, assigned), rows: [action, ...navRow('open', 0, p, open.length)] };
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
    return { text: `${header}\n\n${applicantCard(app, c)}`, rows: [actions, ...navRow('appl', task.id, p, applicants.length)] };
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
    return { text, rows: navRow('actv', 0, p, pages) };
  }

  const sendPage = (ctx: BotContext, view: PageView): Promise<unknown> =>
    ctx.reply(view.text, Markup.inlineKeyboard(view.rows));
  const editPage = (ctx: BotContext, view: PageView): Promise<unknown> =>
    ctx.editMessageText(view.text, Markup.inlineKeyboard(view.rows)).catch(() => undefined);

  // The i/N indicator is a live button (Telegram has no inert buttons); it just acks.
  bot.action('pg:noop', (ctx) => safeAnswerCb(ctx));
  bot.action(/^pg:(open|appl|actv):(\d+):(\d+)$/, async (ctx) => {
    const key = ctx.match[1];
    const arg = Number(ctx.match[2]);
    const page = Number(ctx.match[3]);
    const L = localeOf(ctx);
    let view: PageView;
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
    await listCapped(ctx, L, drafts, (task) => ctx.reply(taskDetail(task, 0), approveButton(task, L)));
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
    const [notif, drafts, open, active, review] = await Promise.all([
      notificationCounts(),
      countDraftTasks(),
      countOpenTasks(),
      countActiveAssignments(),
      countSubmittedForReview(),
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
          review,
          notifQueued: notif.queued + notif.retrying,
          notifFailed: notif.failed,
        }),
      ),
    );
  });

  // ---- Escrow funding queue (admin) ----
  // The bot holds NO treasury key: it reads the chain to show which owed payouts
  // are funded vs pending, flips their status to match, and — for the pending
  // ones whose contributor has linked a wallet — prints the exact `allocate`
  // command for a treasury admin to run themselves (they set the amount, since
  // `reward` is free text). Reads only; funding stays a human, key-in-hand action.
  bot.command('payouts', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const owed = await listPayoutsByStatus(['pending', 'claimable']);
    if (owed.length === 0) return ctx.reply(t(L, 'payouts.none'));
    // One reply per payout, capped like every other admin list (a single joined
    // message would silently clamp past ~12 rows, and a missed row here is
    // missed money) — funding the shown ones shrinks the queue. Context, wallet
    // links, and chain reads are fetched for the shown page only; later rows
    // reconcile when they reach a page.
    const page = owed.slice(0, LIST_PAGE);
    const [byId, tasksById, links] = await Promise.all([
      listContributorsByIds([...new Set(page.map((p) => p.contributor_id))]).then(
        (cs) => new Map(cs.map((c) => [c.telegram_id, c])),
      ),
      listTasksByIds([...new Set(page.map((p) => p.task_id))]).then((ts) => new Map(ts.map((tk) => [tk.id, tk]))),
      // Only a link on the configured network is fundable — a mainnet allocate
      // to a testnet-only account name is money nobody can claim.
      Promise.all(page.map((p) => payableWalletLink(p.contributor_id))),
    ]);
    // The chain reads (inside reconcilePayoutOnChain — the shared settlement rule)
    // are independent: one round trip's latency for the page, not one per row. A
    // row with a pinned funded account reconciles even without a current link.
    const recs = await Promise.all(page.map((p, i) => reconcilePayoutOnChain(p, links[i]?.account_id)));
    await ctx.reply(t(L, 'payouts.title'));
    for (const [i, p] of page.entries()) {
      const task = tasksById.get(p.task_id);
      const title = task ? ` <b>${esc(truncate(task.title, 100))}</b>` : '';
      const head = `#<code>${p.task_id}</code>${title} — 👤 ${who(p.contributor_id, byId.get(p.contributor_id))} · 🎁 ${esc(p.reward)}`;
      const link = links[i];
      // The reconciled status is authoritative: once settled we never re-offer
      // the fund command — a re-run would double-pay. The command shows ONLY when
      // the payout is still pending AND a successful read confirmed it is
      // unfunded (`ok`); an unverified read shows "couldn't check", never the command.
      const { ok, status, funded, amount } = recs[i];
      if (status === 'claimed') await ctx.reply(`${head}\n${t(L, 'payouts.claimed')}`);
      else if (status === 'revoked') await ctx.reply(`${head}\n${t(L, 'payouts.revoked')}`);
      else if (funded && amount) {
        await ctx.reply(
          `${head}\n${t(L, 'payouts.funded', { account: p.account_id ?? link!.account_id, amount: formatNear(amount) })}`,
        );
      } else if (!link && !p.account_id) await ctx.reply(`${head}\n${t(L, 'payouts.needsWallet')}`);
      else if (!ok || !link) await ctx.reply(`${head}\n${t(L, 'payouts.checkFailed')}`);
      else await ctx.reply(`${head}\n${t(L, 'payouts.fundHint')}\n<code>${esc(allocateCommand(p.task_id, link.account_id))}</code>`);
    }
    if (owed.length > page.length) {
      await ctx.reply(t(L, 'list.more', { shown: page.length, total: owed.length }));
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
    const L = localeOf(ctx);
    const scope = await resolveScope(ctx.from?.id);
    if (!scope) return void safeAnswerCb(ctx, t(L, 'common.adminsOnly'), { show_alert: true });
    await safeAnswerCb(ctx);
    await sendReviewPage(ctx, L, scope, Number(ctx.match[1]));
  });

  // ---- Close / reopen (admin) ----
  bot.command('close', (ctx) =>
    adminTaskCommand(ctx, closeTask, 'close.usage', 'close.ok', 'task.closeFail'),
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
      // The announcement rows commit WITH the approval (nested withTransaction
      // joins), because once a task is Open no path would ever announce it again
      // — a lost enqueue would be permanent. A failure rolls the approval back,
      // so the admin can simply tap Approve again. Approval still doesn't wait on
      // Telegram: the background worker delivers the channel post and opt-in DMs
      // after commit, globally rate-limited. The launch-scale audience read + row
      // build happen BEFORE the transaction so they don't hold the task lock (and
      // a pooled connection) across the whole fan-out — only the enqueue does.
      async () => {
        const taskId = Number(ctx.match[1]);
        const draft = await getTask(taskId);
        const rows = draft ? await buildAnnounceRows(draft) : [];
        return withTransaction(async () => {
          const task = await approveTask(taskId, ctx.from!.id);
          await enqueueAnnounceRows(rows);
          return task;
        });
      },
      async (task, L) => ({
        popup: t(L, 'approve.popup'),
        card: t(L, 'approve.opened', { detail: taskDetail(task, 0) }),
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
      async ({ application, task }, L) => ({
        enqueue: async () => notifyApplicant(application, task, 'assigned'),
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

  // No gate: withdrawApplication itself refuses anyone but the owner.
  bot.action(/^withdraw:(\d+)$/, (ctx) =>
    callbackMutation(
      ctx,
      null,
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
    const what = ctx.match[1];
    const on = ctx.match[2] === 'on';
    const L = localeOf(ctx);
    if (what === 'notify') {
      await setAnnounceOptIn(ctx.from!.id, on); // the tapper's own setting — no gate
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
      await ctx.reply(t(L, r.key));
    }
    await safeAnswerCb(ctx);
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
      await registerRoom(chat.id, chat.title ?? null, inviterId);
      await notifyRoomRegistered(chat.id, chat.title ?? null, inviterId, upd.date);
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

  bot.command('enablesignals', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx)) || !(await requireRoomManagerCmd(ctx))) return;
    // The success reply lands in the group — deliberate: it is the members'
    // notice that their messages are now AI-scored (and that nothing is stored).
    const r = await toggleRoomFeature(ctx.chat!.id, 'sig', true);
    return ctx.reply(t(L, r.key));
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
      const room = await getRoom(ctx.chat!.id);
      return ctx.reply(t(L, 'ai.status', { on: room?.ai_enabled === 1 }));
    }
    if (arg !== 'on' && arg !== 'off') return ctx.reply(t(L, 'ai.usage'));
    if (!(await requireRoomManagerCmd(ctx))) return;
    const r = await toggleRoomFeature(ctx.chat!.id, 'ai', arg === 'on');
    return ctx.reply(t(L, r.key));
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
  { command: 'status', description: 'View a task and its history' },
  { command: 'privacy', description: 'What this bot stores about you' },
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
  { command: 'payouts', description: 'Payout funding queue (admin)' },
  { command: 'forget', description: 'Erase a contributor’s data (admin)' },
];
