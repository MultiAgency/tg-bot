import { Telegraf, session, Scenes } from 'telegraf';
import { config, isAdmin } from '../config.js';
import { type BotContext, SCENES, displayName, commandArg, parseId, requirePrivateChat } from './context.js';
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
  slotsTakenForTasks,
  listOpenTasks,
  listDraftTasks,
  countDraftTasks,
  countOpenTasks,
  countActiveAssignments,
  countSubmittedForReview,
  listApplicantsAwaiting,
  countApplicationsAwaitingPerTask,
  listActiveAssignments,
  listApplicationsByContributor,
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
  addRoomAdmin,
  removeRoomAdmin,
  listRoomAdmins,
  isRoomAdmin,
  listRoomsAdministeredBy,
  getRoom,
  signalCountsForRoom,
  contributorLabel,
} from '../core/service.js';
import type { Task } from '../core/models/task.js';
import type { Application } from '../core/models/application.js';
import { TaskStatus, ApplicationStatus, SubmissionStatus } from '../core/workflow.js';
import { withTransaction } from '../core/db.js';
import { isMediaSubmission, type Submission } from '../core/models/submission.js';
import {
  taskDetail,
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
} from './format.js';
import {
  applyButton,
  deepLinkApplyButton,
  approveButton,
  applicantButtons,
  submitButton,
  withdrawButton,
  reviewButtons,
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
 * Command-side gate for task-management commands, room-aware: yields 'all' for
 * a global admin, the set of administered room chat ids for a room admin, and
 * null (after the standard refusal) for everyone else. Applies the same
 * private-chat gate as requireAdminCmd — a room admin's replies render the
 * same contributor PII a global admin's do.
 */
async function requireManagerCmd(ctx: BotContext): Promise<'all' | Set<number> | null> {
  const uid = ctx.from?.id;
  let scope: 'all' | Set<number>;
  if (isAdmin(uid)) {
    scope = 'all';
  } else {
    const roomIds = uid === undefined ? [] : await listRoomsAdministeredBy(uid);
    if (roomIds.length === 0) {
      await ctx.reply(t(localeOf(ctx), 'common.adminsOnly'));
      return null;
    }
    scope = new Set(roomIds);
  }
  return (await requirePrivateChat(ctx, 'common.adminPrivateOnly')) ? scope : null;
}

/** Whether a task falls inside a requireManagerCmd scope. */
const inScope = (scope: 'all' | Set<number>, task: Pick<Task, 'room_chat_id'> | undefined): boolean =>
  scope === 'all' || (task?.room_chat_id != null && scope.has(task.room_chat_id));

/**
 * Callback-side twin of canManageTask: a gate for callbackMutation. Resolves
 * the task lazily (via the application or submission on the card) — when the
 * row is gone, only global admins proceed to the mutation's own "not found";
 * everyone else gets the standard refusal, which never confirms existence.
 */
function requireManageCb(resolveTask: () => Promise<Task | undefined>) {
  return async (ctx: BotContext): Promise<boolean> => {
    if (await canManageTask(ctx.from?.id, await resolveTask())) return true;
    await ctx.answerCbQuery(t(localeOf(ctx), 'common.adminsOnly'), { show_alert: true });
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
    await ctx.answerCbQuery(errorMessage(err, t(L, 'common.somethingWrong')), { show_alert: true });
    return;
  }
  const { enqueue, popup, card } = await outcome(result, L);
  await enqueue?.();
  await ctx.answerCbQuery(popup);
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

  // /start may carry a deep-link payload from the announcement channel's Apply
  // button (?start=t<taskId>) — jump straight into applying for that task.
  bot.start(async (ctx) => {
    const match = /^t(\d+)$/.exec(ctx.startPayload ?? '');
    if (match) return ctx.scene.enter(SCENES.apply, { taskId: Number(match[1]) });
    return ctx.reply(await help(ctx));
  });
  bot.help(async (ctx) => ctx.reply(await help(ctx)));
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
  // ('list.more' / 'open.more'); acting on the shown items shrinks the queues.
  const LIST_PAGE = 15;
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
    moreKey: 'list.more' | 'open.more' = 'list.more',
  ): Promise<void> {
    for (const item of items.slice(0, LIST_PAGE)) await render(item);
    if (items.length > LIST_PAGE) {
      await ctx.reply(t(L, moreKey, { shown: LIST_PAGE, total: items.length }));
    }
  }

  /** Render a page of a contributor's applications, batching the per-row task and
   *  latest-submission lookups; `buttonFor` picks each row's button (or none). */
  async function renderApplicationList(
    ctx: BotContext,
    L: string,
    apps: Application[],
    buttonFor: (app: Application, latest: Submission | undefined) => ReturnType<typeof submitButton> | undefined,
  ): Promise<void> {
    const page = apps.slice(0, LIST_PAGE);
    const tasksById = new Map((await listTasksByIds([...new Set(page.map((a) => a.task_id))])).map((tk) => [tk.id, tk]));
    const latestByApp = await latestSubmissionsByApplication(page.map((a) => a.id));
    await listCapped(ctx, L, apps, async (app) => {
      const latest = latestByApp.get(app.id);
      const line = applicationLine(app, tasksById.get(app.task_id), latest);
      const button = buttonFor(app, latest);
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
  bot.command('open', async (ctx) => {
    const L = localeOf(ctx);
    const open = await listOpenTasks();
    if (open.length === 0) return ctx.reply(t(L, 'open.none'));
    await ctx.reply(t(L, 'open.count', { n: open.length }));
    // Slot counts for the whole visible page in one grouped query, instead of a
    // COUNT per task inside the render loop.
    const slots = await slotsTakenForTasks(open.slice(0, LIST_PAGE).map((task) => task.id));
    await listCapped(
      ctx,
      L,
      open,
      async (task) => {
        const assigned = slots.get(task.id) ?? 0;
        // Fully assigned: keep it visible, but there is nothing to apply to.
        if (assigned >= task.max_assignees) {
          return ctx.reply(t(L, 'open.fullyAssigned', { detail: taskDetail(task, assigned) }));
        }
        // The callback Apply button only works in a private chat (the pitch
        // wizard needs replies groups never deliver). In a group, deep-link into
        // the DM instead — but only when the bot @username is known to build the
        // link; without it, render the card with NO button (a callback here would
        // dead-end into the private-chat guard, leaking the wizard refusal to the
        // group) and let the "/open in a DM" affordance carry it.
        const detail = taskDetail(task, assigned);
        if (ctx.chat.type === 'private') return ctx.reply(detail, applyButton(task, L));
        if (config.botUsername) return ctx.reply(detail, deepLinkApplyButton(task, config.botUsername, L));
        return ctx.reply(detail);
      },
      'open.more',
    );
  });

  // ---- A contributor's own applications ----
  bot.command('myapps', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    const uid = ctx.from!.id;
    const apps = await listApplicationsByContributor(uid);
    const profile = await getContributor(uid);
    if (apps.length === 0) {
      return ctx.reply(`${profile ? contributorProfile(profile) + '\n\n' : ''}${t(L, 'myapps.none')}`);
    }
    if (profile) await ctx.reply(contributorProfile(profile));
    await renderApplicationList(ctx, L, apps, (app, latest) => {
      // Only offer a button the service will actually accept: Submit when work is
      // due (no version yet, or the last was sent back for revision), Withdraw
      // only while still an applicant. Assignments that are awaiting review or
      // finished (completed/rejected) get no button — those taps would only fail.
      const canSubmit =
        app.status === ApplicationStatus.Assigned &&
        (!latest || latest.status === SubmissionStatus.NeedsRevision);
      if (canSubmit) return submitButton(app, L);
      if (app.status === ApplicationStatus.Applied) return withdrawButton(app, L);
      return undefined;
    });
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
    const assigned = (await listApplicationsByContributor(uid)).filter((a) => a.status === ApplicationStatus.Assigned);
    if (assigned.length === 0) return ctx.reply(t(L, 'submit.none'));
    if (assigned.length === 1) return ctx.scene.enter(SCENES.submit, { applicationId: assigned[0].id });
    await ctx.reply(t(L, 'submit.which'));
    await renderApplicationList(ctx, L, assigned, (app) => submitButton(app, L));
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
    const applicants = await listApplicantsAwaiting(id);
    await ctx.reply(
      t(L, 'applicants.header', {
        id,
        // Truncated like every other title render — a raw near-4096-char title
        // would push this reply over Telegram's limit and kill the command.
        title: truncate(task.title, 200),
        assigned: await countSlotsTaken(id),
        max: task.max_assignees,
        n: applicants.length,
      }),
    );
    const byId = new Map(
      (await listContributorsByIds([...new Set(applicants.slice(0, LIST_PAGE).map((a) => a.contributor_id))])).map((c) => [
        c.telegram_id,
        c,
      ]),
    );
    await listCapped(ctx, L, applicants, async (app) =>
      ctx.reply(applicantCard(app, byId.get(app.contributor_id)), applicantButtons(app, L)),
    );
  });

  // ---- Active assignments (admin) ----
  bot.command('active', async (ctx) => {
    const L = localeOf(ctx);
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    // Batch the task lookups needed for the scope filter (one query, not one per
    // assignment), then batch the shown page's submissions and contributors.
    const assignments = await listActiveAssignments();
    const tasksById = new Map(
      (await listTasksByIds([...new Set(assignments.map((a) => a.task_id))])).map((tk) => [tk.id, tk]),
    );
    const active = assignments
      .map((app) => ({ app, task: tasksById.get(app.task_id) }))
      .filter(({ task }) => inScope(scope, task));
    if (active.length === 0) return ctx.reply(t(L, 'active.none'));
    // Stalest-first, capped like every other list, then chunked — 15 worst-case
    // rows can top 4096 chars, and clampMessage would silently drop rows (and
    // their /unassign ids) off the end instead.
    const page = active.slice(0, LIST_PAGE);
    const latestByApp = await latestSubmissionsByApplication(page.map(({ app }) => app.id));
    const contributorsById = new Map(
      (await listContributorsByIds([...new Set(page.map(({ app }) => app.contributor_id))])).map((c) => [
        c.telegram_id,
        c,
      ]),
    );
    const lines = page.map(({ app, task }) =>
      activeLine(app, task, latestByApp.get(app.id), contributorsById.get(app.contributor_id)),
    );
    for (const part of chunkMessage(t(L, 'active.header', { n: active.length, lines: lines.join('\n') }))) {
      await ctx.reply(part);
    }
    if (active.length > LIST_PAGE) {
      await ctx.reply(t(L, 'list.more', { shown: LIST_PAGE, total: active.length }));
    }
    await ctx.reply(t(L, 'active.hint'));
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

  // ---- Reviewing submissions (admin) ----
  bot.command('review', async (ctx) => {
    const L = localeOf(ctx);
    const scope = await requireManagerCmd(ctx);
    if (!scope) return;
    // Resolve the whole backlog's applications and tasks in two batched queries
    // (not two per submission), so cost is O(1) round trips regardless of how
    // deep the review queue is; only the shown page's contributors are fetched.
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
    if (subs.length === 0) return ctx.reply(t(L, 'review.none'));
    await ctx.reply(t(L, 'review.count', { n: subs.length }));
    // Budgeted in MESSAGES, not rows: a media submission costs two sends
    // (card + attachment), and it is the send count that trips Telegram's
    // per-chat flood limit the LIST_PAGE cap exists to stay under.
    // One pass selects the rows that fit the message budget and collects their
    // contributor ids; a single query then fetches those contributors. Rendering
    // iterates the same `page`, so the prefetched set can never drift from the
    // rendered rows (two loops each re-deriving the budget could).
    const page: typeof subs = [];
    const pageIds = new Set<number>();
    let budget = 0;
    for (const row of subs) {
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
        await sendSubmissionAttachment(ctx.telegram, ctx.chat!.id, sub);
      } catch {
        // The reviewer must know an attachment exists but didn't load — a
        // silent miss here would mean deciding on work they never saw.
        await ctx.reply(t(L, 'review.attachFail')).catch(() => undefined);
      }
      shown += 1;
    }
    if (shown < subs.length) {
      await ctx.reply(t(L, 'list.more', { shown, total: subs.length })).catch(() => undefined);
    }
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
    // Open/closed tasks are public; drafts are admin-only; applicants can always
    // see a task they engaged with.
    const authorized =
      task && (admin || task.status !== TaskStatus.Draft || !!(await getApplicationFor(id, uid)));
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
        return [aid, c ? contributorLabel(c) : `user ${aid}`] as const;
      }),
    );
    const slots = await countSlotsTaken(id);
    const text = `${taskDetail(task, slots)}\n\n🕓 History:\n${omitted}${historyBlock(recent, labels)}`;
    for (const part of chunkMessage(text)) await ctx.reply(part);
  });

  // ---- Callback actions ----
  bot.action(/^apply:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
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
      async (app, L) => ({
        enqueue: async () => notifyApplicant(app, await getTask(app.task_id), 'assigned'),
        popup: t(L, 'assign.popup'),
        card: t(L, 'assign.ok', { taskId: app.task_id }),
      }),
    ),
  );

  bot.action(/^decline:(\d+)$/, (ctx) =>
    callbackMutation(
      ctx,
      requireManageCb(() => taskOfApplication(Number(ctx.match[1]))),
      () => declineApplication(Number(ctx.match[1]), ctx.from!.id),
      async (app, L) => ({
        enqueue: async () => notifyApplicant(app, await getTask(app.task_id), 'declined'),
        popup: t(L, 'decline.popup'),
        card: t(L, 'decline.ok', { taskId: app.task_id }),
      }),
    ),
  );

  bot.action(/^submit:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
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
    if (!sub) return ctx.answerCbQuery(t(L, 'full.gone'), { show_alert: true });
    await ctx.answerCbQuery();
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
        async (sub, L) => {
          const app = (await getApplication(sub.application_id))!;
          return {
            enqueue: async () =>
              notifyContributorReview(sub.id, app.contributor_id, await getTask(app.task_id), 'approve', null),
            popup: t(L, 'reviewAction.popup'),
            card: t(L, 'reviewAction.approved', { id: submissionId }),
          };
        },
      );
    }
    if (!(await gate(ctx))) return;
    await ctx.answerCbQuery();
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

  /**
   * Ensure the room row exists (the bot may predate this feature in a group,
   * so my_chat_member never fired), refresh its title, and check the caller.
   * A legacy room starts with no admins — a global admin bootstraps it.
   */
  async function requireRoomManagerCmd(ctx: BotContext): Promise<boolean> {
    const chatId = ctx.chat!.id;
    await registerRoom(chatId, chatTitle(ctx), null);
    if (await canManageRoom(ctx.from?.id, chatId)) return true;
    await ctx.reply(t(localeOf(ctx), 'rooms.roomAdminsOnly'));
    return false;
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
      // Kicked/left: stop scanning. The room row and its admins stay — they are
      // provenance for existing tasks, and re-adding the bot restores them.
      try {
        await setRoomSignals(chat.id, false);
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
    if (!ai.aiEnabled()) return ctx.reply(t(L, 'signals.needsAi'));
    await setRoomSignals(ctx.chat!.id, true);
    // The reply lands in the group — deliberate: it is the members' notice that
    // their messages are now AI-scored (and that nothing is stored).
    return ctx.reply(t(L, 'signals.enabled'));
  });

  bot.command('disablesignals', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireGroupCmd(ctx)) || !(await requireRoomManagerCmd(ctx))) return;
    await setRoomSignals(ctx.chat!.id, false);
    return ctx.reply(t(L, 'signals.disabled'));
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
      .map((id) => {
        const c = adminsById.get(id);
        return `• ${c ? contributorLabel(c) : `user ${id}`}`;
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
    if (text.startsWith('/')) return; // commands (incl. unknown ones) are not signals
    // Detached AND tracked from the very first await: the whole handler (budget
    // claim included, not just the model call) must be in the drain set, or a
    // signal claimed as shutdown begins strands its draft 'evaluating'.
    runDetached('signals', (signal) => handleGroupMessage(ctx.chat.id, text, signal));
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
  { command: 'forget', description: 'Erase a contributor’s data (admin)' },
];
