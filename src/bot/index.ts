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
  listApplicationsByContributor,
  listSubmittedForReview,
  latestSubmission,
  getSubmission,
  getApplicationFor,
  getContributor,
  upsertContributor,
  setAnnounceOptIn,
  notificationCounts,
  listHistory,
  TASK_LEVEL_ACTIONS,
  errorMessage,
} from '../core/service.js';
import { TaskStatus, ApplicationStatus, SubmissionStatus } from '../core/workflow.js';
import { isMediaSubmission } from '../core/models/submission.js';
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
import { applyButton, approveButton, applicantButtons, submitButton, withdrawButton, reviewButtons } from './keyboards.js';
import {
  notifyContributorReview,
  notifyApplicant,
  announceOpenTask,
  sendSubmissionAttachment,
} from './notify.js';
import { newTaskScene } from './scenes/newTask.js';
import { applyScene } from './scenes/apply.js';
import { submitScene } from './scenes/submit.js';
import { reviewNoteScene } from './scenes/review.js';
import { unassignScene } from './scenes/unassign.js';
import { t, localeOf } from './i18n.js';
import * as ai from '../ai/assist.js';

const help = (ctx: BotContext) =>
  t(localeOf(ctx), 'help.text', { admin: isAdmin(ctx.from?.id), ai: ai.aiEnabled() });

async function requireAdminCb(ctx: BotContext): Promise<boolean> {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.answerCbQuery(t(localeOf(ctx), 'common.adminsOnly'), { show_alert: true });
    return false;
  }
  return true;
}

/**
 * Command-side twin of requireAdminCb: refuse non-admins with the standard
 * reply. Also gates on a private chat — admin replies render contributor PII
 * (pitches, ids, raw submissions) and must never land in a group the bot sits
 * in (e.g. the announcement group, where commands still arrive under
 * Telegram's default privacy mode).
 */
async function requireAdminCmd(ctx: BotContext): Promise<boolean> {
  if (!isAdmin(ctx.from?.id)) {
    await ctx.reply(t(localeOf(ctx), 'common.adminsOnly'));
    return false;
  }
  return requirePrivateChat(ctx, 'common.adminPrivateOnly');
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
 * Shared skeleton for admin callback buttons that commit one service mutation.
 * It pins three easy-to-drop invariants in one place:
 *  - only the mutation sits inside the try — once it commits, a failure below
 *    must surface in bot.catch, not as a false "Something went wrong";
 *  - the durable follow-up (outcome.enqueue) runs straight after the commit,
 *    before any Telegram send can fail and cost it;
 *  - the card edit tolerates a stale or deleted card instead of throwing.
 */
async function adminCallbackMutation<T>(
  ctx: BotContext,
  mutate: () => T,
  outcome: (result: T, L: string) => { enqueue: () => void; popup: string; card: string },
): Promise<void> {
  if (!(await requireAdminCb(ctx))) return;
  const L = localeOf(ctx);
  let result: T;
  try {
    result = mutate();
  } catch (err) {
    await ctx.answerCbQuery(errorMessage(err, t(L, 'common.somethingWrong')), { show_alert: true });
    return;
  }
  const { enqueue, popup, card } = outcome(result, L);
  enqueue();
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
  bot.use((ctx, next) => {
    const from = ctx.from;
    // Private chats only: groups deliver every member's /commands to the bot,
    // and profiling people who merely typed near it would collect PII from
    // non-users. Every real user path passes through a DM (wizards and the
    // announcement deep-link both force one), so nobody the bot serves is missed.
    if (from && !from.is_bot && ctx.chat?.type === 'private') {
      upsertContributor(from.id, from.username ?? null, displayName(from) || null, from.language_code ?? null);
    }
    return next();
  });
  bot.use(stage.middleware());

  // /start may carry a deep-link payload from the announcement channel's Apply
  // button (?start=t<taskId>) — jump straight into applying for that task.
  bot.start(async (ctx) => {
    const match = /^t(\d+)$/.exec(ctx.startPayload ?? '');
    if (match) return ctx.scene.enter(SCENES.apply, { taskId: Number(match[1]) });
    return ctx.reply(help(ctx));
  });
  bot.help((ctx) => ctx.reply(help(ctx)));
  // Transparency surface: what's stored, retention, the AI third-party flow
  // (when enabled), and how erasure works. Contains no personal data itself,
  // so it answers anywhere — including groups, where the curious will ask.
  bot.command('privacy', (ctx) => ctx.reply(t(localeOf(ctx), 'privacy.text', { ai: ai.aiEnabled() })));
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

  bot.command('approve', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const drafts = listDraftTasks();
    if (drafts.length === 0) return ctx.reply(t(L, 'approve.none'));
    await ctx.reply(t(L, 'approve.count', { n: drafts.length }));
    await listCapped(ctx, L, drafts, (task) => ctx.reply(taskDetail(task, 0), approveButton(task, L)));
  });

  // ---- Open tasks & applying ----
  bot.command('open', async (ctx) => {
    const L = localeOf(ctx);
    const open = listOpenTasks();
    if (open.length === 0) return ctx.reply(t(L, 'open.none'));
    await ctx.reply(t(L, 'open.count', { n: open.length }));
    await listCapped(
      ctx,
      L,
      open,
      (task) => {
        const assigned = countSlotsTaken(task.id);
        // Fully assigned: keep it visible, but there is nothing to apply to.
        return assigned >= task.max_assignees
          ? ctx.reply(t(L, 'open.fullyAssigned', { detail: taskDetail(task, assigned) }))
          : ctx.reply(taskDetail(task, assigned), applyButton(task, L));
      },
      'open.more',
    );
  });

  // ---- A contributor's own applications ----
  bot.command('myapps', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    const uid = ctx.from!.id;
    const apps = listApplicationsByContributor(uid);
    const profile = getContributor(uid);
    if (apps.length === 0) {
      return ctx.reply(`${profile ? contributorProfile(profile) + '\n\n' : ''}${t(L, 'myapps.none')}`);
    }
    if (profile) await ctx.reply(contributorProfile(profile));
    await listCapped(ctx, L, apps, (app) => {
      const task = getTask(app.task_id);
      const latest = latestSubmission(app.id);
      const line = applicationLine(app, task, latest);
      // Only offer a button the service will actually accept: Submit when work is
      // due (no version yet, or the last was sent back for revision), Withdraw
      // only while still an applicant. Assignments that are awaiting review or
      // finished (completed/rejected) get no button — those taps would only fail.
      const canSubmit =
        app.status === ApplicationStatus.Assigned &&
        (!latest || latest.status === SubmissionStatus.NeedsRevision);
      if (canSubmit) return ctx.reply(line, submitButton(app, L));
      if (app.status === ApplicationStatus.Applied) return ctx.reply(line, withdrawButton(app, L));
      return ctx.reply(line);
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
    const assigned = listApplicationsByContributor(uid).filter((a) => a.status === ApplicationStatus.Assigned);
    if (assigned.length === 0) return ctx.reply(t(L, 'submit.none'));
    if (assigned.length === 1) return ctx.scene.enter(SCENES.submit, { applicationId: assigned[0].id });
    await ctx.reply(t(L, 'submit.which'));
    await listCapped(ctx, L, assigned, (app) =>
      ctx.reply(applicationLine(app, getTask(app.task_id), latestSubmission(app.id)), submitButton(app, L)),
    );
  });

  // ---- Task-announcement DM opt-in (contributor-controlled) ----
  bot.command('notify', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    const uid = ctx.from!.id;
    const arg = commandArg(ctx)?.toLowerCase();
    if (arg === 'on' || arg === 'off') {
      setAnnounceOptIn(uid, arg === 'on');
      return ctx.reply(t(L, arg === 'on' ? 'optin.on' : 'optin.off'));
    }
    return ctx.reply(t(L, 'optin.status', { on: getContributor(uid)?.announce_opt_in === 1 }));
  });

  bot.command('withdraw', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requirePrivateCmd(ctx))) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'withdraw.usage'));
    try {
      const app = withdrawApplication(id, ctx.from!.id);
      await ctx.reply(t(L, 'withdraw.ok', { taskId: app.task_id }));
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, 'withdraw.fail')));
    }
  });

  // ---- Applicant review & assignment (admin) ----
  bot.command('applicants', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'applicants.usage'));
    const task = getTask(id);
    if (!task) return ctx.reply(t(L, 'applicants.notFound', { id }));
    const applicants = listApplicantsAwaiting(id);
    await ctx.reply(
      t(L, 'applicants.header', {
        id,
        // Truncated like every other title render — a raw near-4096-char title
        // would push this reply over Telegram's limit and kill the command.
        title: truncate(task.title, 200),
        assigned: countSlotsTaken(id),
        max: task.max_assignees,
        n: applicants.length,
      }),
    );
    await listCapped(ctx, L, applicants, (app) => ctx.reply(applicantCard(app), applicantButtons(app, L)));
  });

  // ---- Active assignments (admin) ----
  bot.command('active', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const active = listActiveAssignments();
    if (active.length === 0) return ctx.reply(t(L, 'active.none'));
    // Stalest-first, capped like every other list, then chunked — 15 worst-case
    // rows can top 4096 chars, and clampMessage would silently drop rows (and
    // their /unassign ids) off the end instead.
    const lines = active
      .slice(0, LIST_PAGE)
      .map((app) => activeLine(app, getTask(app.task_id), latestSubmission(app.id)));
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
    const perTask = countApplicationsAwaitingPerTask();
    const where = perTask.length
      ? ` (${perTask.map((r) => `#${r.task_id}×${r.n}`).join(' ')})`
      : '';
    const notif = notificationCounts();
    // clampMessage: the per-task `where` breakdown grows with the task count.
    await ctx.reply(
      clampMessage(
        t(L, 'admin.overview', {
          drafts: countDraftTasks(),
          open: countOpenTasks(),
          applications: perTask.reduce((sum, r) => sum + r.n, 0),
          where,
          active: countActiveAssignments(),
          review: countSubmittedForReview(),
          notifQueued: notif.queued + notif.retrying,
          notifFailed: notif.failed,
        }),
      ),
    );
  });

  // ---- Reviewing submissions (admin) ----
  bot.command('review', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const subs = listSubmittedForReview();
    if (subs.length === 0) return ctx.reply(t(L, 'review.none'));
    await ctx.reply(t(L, 'review.count', { n: subs.length }));
    // Budgeted in MESSAGES, not rows: a media submission costs two sends
    // (card + attachment), and it is the send count that trips Telegram's
    // per-chat flood limit the LIST_PAGE cap exists to stay under.
    let sent = 0;
    let shown = 0;
    for (const sub of subs) {
      const cost = isMediaSubmission(sub.type) ? 2 : 1;
      if (sent + cost > LIST_PAGE) break;
      const app = getApplication(sub.application_id);
      if (!app) continue;
      const task = getTask(app.task_id);
      await ctx.reply(submissionReviewCard(sub, app, task), reviewButtons(sub, L));
      try {
        await sendSubmissionAttachment(ctx.telegram, ctx.chat!.id, sub);
      } catch {
        // The reviewer must know an attachment exists but didn't load — a
        // silent miss here would mean deciding on work they never saw.
        await ctx.reply(t(L, 'review.attachFail'));
      }
      sent += cost;
      shown += 1;
    }
    if (shown < subs.length) {
      await ctx.reply(t(L, 'list.more', { shown, total: subs.length }));
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
    mutate: (taskId: number, adminId: number) => { id: number },
    usageKey: 'close.usage' | 'reopen.usage',
    okKey: 'close.ok' | 'reopen.ok',
    failKey: 'task.closeFail' | 'task.reopenFail',
  ): Promise<void> {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const id = parseId(commandArg(ctx));
    if (id === null) {
      await ctx.reply(t(L, usageKey));
      return;
    }
    try {
      const task = mutate(id, ctx.from!.id);
      await ctx.reply(t(L, okKey, { id: task.id }));
    } catch (err) {
      await ctx.reply(errorMessage(err, t(L, failKey)));
    }
  }

  // ---- Unassign (admin) — reason captured in a scene ----
  bot.command('unassign', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'unassign.usage'));
    return ctx.scene.enter(SCENES.unassign, { applicationId: id });
  });

  // ---- Erasure (admin) ----
  bot.command('forget', async (ctx) => {
    const L = localeOf(ctx);
    if (!(await requireAdminCmd(ctx))) return;
    const id = parseId(commandArg(ctx));
    if (id === null) return ctx.reply(t(L, 'forget.usage'));
    try {
      forgetContributor(id, ctx.from!.id);
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
    const task = getTask(id);
    const uid = ctx.from!.id;
    const dm = ctx.chat?.type === 'private';
    // Admin visibility (drafts, everyone's history — pitches, names, notes) is
    // DM-only: /status is a public command that groups deliver too, and an
    // admin typing it there must not dump contributor data into the group.
    const admin = isAdmin(uid) && dm;
    // Open/closed tasks are public; drafts are admin-only; applicants can always
    // see a task they engaged with.
    const authorized =
      task && (admin || task.status !== TaskStatus.Draft || !!getApplicationFor(id, uid));
    if (!task || !authorized) return ctx.reply(t(L, 'status.notVisible', { id }));
    const entries = listHistory(id);
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
    const text = `${taskDetail(task, countSlotsTaken(id))}\n\n🕓 History:\n${omitted}${historyBlock(recent)}`;
    for (const part of chunkMessage(text)) await ctx.reply(part);
  });

  // ---- Callback actions ----
  bot.action(/^apply:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter(SCENES.apply, { taskId: Number(ctx.match[1]) });
  });

  bot.action(/^approve:(\d+)$/, (ctx) =>
    adminCallbackMutation(
      ctx,
      () => approveTask(Number(ctx.match[1]), ctx.from!.id),
      (task, L) => ({
        // Enqueue only — the background worker delivers the channel post and
        // any opt-in DMs, globally rate-limited (once the task is Open there
        // is no path that would ever announce it again).
        enqueue: () => announceOpenTask(task),
        popup: t(L, 'approve.popup'),
        card: t(L, 'approve.opened', { detail: taskDetail(task, 0) }),
      }),
    ),
  );

  bot.action(/^assign:(\d+)$/, (ctx) =>
    adminCallbackMutation(
      ctx,
      () => assignApplication(Number(ctx.match[1]), ctx.from!.id),
      (app, L) => ({
        enqueue: () => notifyApplicant(app, getTask(app.task_id), 'assigned'),
        popup: t(L, 'assign.popup'),
        card: t(L, 'assign.ok', { taskId: app.task_id }),
      }),
    ),
  );

  bot.action(/^decline:(\d+)$/, (ctx) =>
    adminCallbackMutation(
      ctx,
      () => declineApplication(Number(ctx.match[1]), ctx.from!.id),
      (app, L) => ({
        enqueue: () => notifyApplicant(app, getTask(app.task_id), 'declined'),
        popup: t(L, 'decline.popup'),
        card: t(L, 'decline.ok', { taskId: app.task_id }),
      }),
    ),
  );

  bot.action(/^submit:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter(SCENES.submit, { applicationId: Number(ctx.match[1]) });
  });

  bot.action(/^withdraw:(\d+)$/, async (ctx) => {
    const L = localeOf(ctx);
    try {
      const app = withdrawApplication(Number(ctx.match[1]), ctx.from!.id);
      await ctx.answerCbQuery(t(L, 'withdraw.popup'));
      await ctx.editMessageText(t(L, 'withdraw.ok', { taskId: app.task_id })).catch(() => undefined);
    } catch (err) {
      await ctx.answerCbQuery(errorMessage(err, t(L, 'withdraw.fail')), { show_alert: true });
    }
  });

  // Full submission content on demand: cards clip long text to stay compact,
  // but the decision surface must let the reviewer read every character.
  // Inbound Telegram text is ≤4096 chars, so this is one message today;
  // chunkMessage guards any future ingestion path that stores more.
  bot.action(/^full:(\d+)$/, async (ctx) => {
    if (!(await requireAdminCb(ctx))) return;
    const L = localeOf(ctx);
    const sub = getSubmission(Number(ctx.match[1]));
    if (!sub) return ctx.answerCbQuery(t(L, 'full.gone'), { show_alert: true });
    await ctx.answerCbQuery();
    for (const part of chunkMessage(fullSubmissionText(sub))) await ctx.reply(part);
  });

  bot.action(/^rev:(approve|reject|revise):(\d+)$/, async (ctx) => {
    const decision = ctx.match[1] as 'approve' | 'reject' | 'revise';
    const submissionId = Number(ctx.match[2]);
    // Approve decides immediately; reject/revise first collect a note in a scene.
    if (decision === 'approve') {
      return adminCallbackMutation(
        ctx,
        () => reviewSubmission(submissionId, ctx.from!.id, 'approve', null),
        (sub, L) => {
          const app = getApplication(sub.application_id)!;
          return {
            enqueue: () =>
              notifyContributorReview(sub.id, app.contributor_id, getTask(app.task_id), 'approve', null),
            popup: t(L, 'reviewAction.popup'),
            card: t(L, 'reviewAction.approved', { id: submissionId }),
          };
        },
      );
    }
    if (!(await requireAdminCb(ctx))) return;
    await ctx.answerCbQuery();
    await ctx.scene.enter(SCENES.review, { submissionId, decision });
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
