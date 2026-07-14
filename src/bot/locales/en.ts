/**
 * English catalog — the single source of truth for the bot's user-facing chrome.
 * Entries are either a plain string or a function of interpolation params.
 * A future locale is a copy of this file with translated values (same keys).
 *
 * Every string here is sent under Telegram's HTML parse mode (see createBot), so:
 *   - dynamic values that are USER content (a task title, a name, a note) are
 *     wrapped in esc() at interpolation — an unescaped '<' would 400 the send;
 *   - values that arrive ALREADY composed by src/bot/format.ts (detail, card,
 *     line, lines, header) are pre-escaped HTML and must NOT be re-escaped;
 *   - any literal '<', '>' or '&' in the fixed chrome is written as an entity
 *     (&lt; &gt; &amp;) — e.g. command placeholders read &lt;taskId&gt;.
 * Button labels (btn.*) are the exception: Telegram never HTML-parses them.
 */
import { esc } from '../format.js';

// Locale-internal helpers for the notify.* entries: the task reference (with a
// translatable fallback when the task row is gone) and the optional note line.
// A translated catalog brings its own versions.
type TaskRef = { taskId: number | null; title: string };
const yourTask = (p: TaskRef) => (p.taskId === null ? 'your task' : `#${p.taskId} "${esc(p.title)}"`);
const aTask = (p: TaskRef) => (p.taskId === null ? 'a task' : `#${p.taskId} "${esc(p.title)}"`);
const noteLine = (note: string | null) => (note ? `\n\n📝 Note: ${esc(note)}` : '');
// Shared tail of both private-chat redirects (requirePrivateChat's messages).
const dmMe = (username: string | null) => `${username ? `Message @${username}` : 'DM me'} and try again.`;

export const en = {
  // ---- common ----
  'common.adminsOnly': 'Admins only.',
  'common.adminPrivateOnly': (p: { username: string | null }) =>
    `Admin commands only work in a private chat — their replies can contain contributor data. ${dmMe(p.username)}`,
  'common.privateOnly': (p: { username: string | null }) =>
    `This command shows your personal data, so it only works in a private chat. ${dmMe(p.username)}`,
  'common.somethingWrong': 'Something went wrong.',
  'common.nothingToCancel': 'Nothing to cancel.',
  'common.cancelled': 'Cancelled.',
  'list.more': (p: { shown: number; total: number }) => `…showing the first ${p.shown} of ${p.total}.`,

  // ---- inline keyboard buttons ----
  'btn.apply': (p: { id: number }) => `🙋 Apply to #${p.id}`,
  'btn.approveOpen': (p: { id: number }) => `✅ Approve & open #${p.id}`,
  'btn.assign': '✅ Assign',
  'btn.decline': '🚫 Decline',
  'btn.submit': '📬 Submit work',
  'btn.withdraw': '↩️ Withdraw',
  'btn.revApprove': '✅ Approve',
  'btn.revReject': '❌ Reject',
  'btn.revRevise': '🔁 Revise',
  'btn.full': '📄 Full submission',
  'btn.reviewNext': 'Next page ▶',
  'btn.home.open': '📋 Browse tasks',
  'btn.home.myapps': '🗂 My work',
  'btn.home.settings': '⚙️ Settings',
  'btn.home.help': 'ℹ️ Help',
  'btn.home.board': '🖼 Open the board',
  'btn.share': '📤 Share',
  'wizard.buttonBusy': 'Finish the current step first, or send /cancel to exit.',
  'wizard.commandsPaused': 'You are in the middle of a step — commands are paused. Send /cancel to exit first.',
  'wizard.privateOnly': (p: { username: string | null }) =>
    `This step only works in a private chat — group chats don’t deliver regular messages to the bot. ${dmMe(p.username)}`,

  // ---- help ----
  'help.text': (p: { admin: boolean; roomAdmin: boolean; ai: boolean }): string => {
    const contributor = [
      '👋 MultiAgency contributor bot',
      '',
      'Contributor commands:',
      '/open — browse open tasks and apply',
      '/myapps — your applications; submit assigned work',
      '/submit &lt;applicationId&gt; — submit work for an assignment',
      '/withdraw &lt;applicationId&gt; — withdraw an application',
      '/notify on|off — task-announcement DMs (off by default)',
      '/status &lt;taskId&gt; — a task and its history',
      '/privacy — what this bot stores about you',
    ];
    // Room admins get the task-management commands, scoped to their rooms' tasks.
    const managerScope = p.admin ? '' : ' (your rooms’ tasks)';
    const manager = [
      '',
      p.admin ? 'Admin commands:' : `Room-admin commands${managerScope}:`,
      ...(p.admin ? ['/admin — overview: what needs you, and where', '/newtask — create a task (set max assignees)'] : []),
      '/approve — approve draft tasks',
      '/applicants &lt;taskId&gt; — review applicants; assign or decline',
      '/active — assignments in progress',
      '/review — review submitted work',
      '/close &lt;taskId&gt; — stop accepting applications',
      '/reopen &lt;taskId&gt; — reopen for applications',
      '/unassign &lt;applicationId&gt; — remove an assignment (records a reason)',
      ...(p.admin ? ['/forget &lt;contributorId&gt; — erase a contributor’s data'] : []),
      '',
      'In a group the bot is in: /enablesignals, /disablesignals, /signalstatus (AI task drafts from chat), and /addroomadmin, /removeroomadmin, /roomadmins (reply to a message to pick the person).',
    ];
    const footer = ['', '/cancel — abort the current step', p.ai ? '🤖 AI drafting is enabled.' : ''];
    return [...contributor, ...(p.admin || p.roomAdmin ? manager : []), ...footer].join('\n');
  },

  // ---- task creation & approval ----
  'approve.none': 'No draft tasks awaiting approval.',
  'approve.count': (p: { n: number }) => `📝 ${p.n} draft task(s):`,
  'approve.opened': (p: { detail: string }) => `✅ Approved &amp; opened:\n\n${p.detail}`,
  'approve.popup': 'Opened!',

  // ---- open & apply ----
  'open.none': 'No open tasks right now. Check back soon!',

  // ---- myapps ----
  'myapps.none': 'You have no applications yet. Browse /open.',

  // ---- submit ----
  'submit.usage': 'Usage: /submit &lt;applicationId&gt; — the "id" number shown on your /myapps rows.',
  'submit.none': 'You have no assigned tasks to submit. See /myapps.',
  'submit.which': 'Which assignment are you submitting? Tap one:',

  // ---- withdraw ----
  'withdraw.usage': 'Usage: /withdraw &lt;applicationId&gt; — the "id" number shown on your /myapps rows.',
  'withdraw.ok': (p: { taskId: number }) => `↩️ Withdrew your application for #${p.taskId}.`,
  'withdraw.fail': 'Could not withdraw.',
  'withdraw.popup': 'Withdrawn',

  // ---- applicants ----
  'applicants.usage': 'Usage: /applicants &lt;taskId&gt;',
  'applicants.header': (p: { id: number; title: string; assigned: number; max: number; n: number }) =>
    `👥 Task #${p.id} "${esc(p.title)}" — ${p.assigned}/${p.max} assigned, ${p.n} awaiting decision:`,

  // ---- active ----
  'active.none': 'No assignments in progress.',
  'active.header': (p: { n: number; lines: string }) => `🛠️ ${p.n} assignment(s) in progress:\n${p.lines}`,
  'active.hint': 'Unassign one with /unassign &lt;applicationId&gt; — the "id" number shown on each row above.',

  // ---- review ----
  'review.none': 'No submissions awaiting review. 🎉',
  'review.count': (p: { n: number }) => `📬 ${p.n} submission(s) awaiting review:`,
  'review.more': (p: { shown: number; total: number }) =>
    `📬 Showing ${p.shown} of ${p.total} — tap for the next page.`,
  'review.end':
    'End of the queue. Cards above that you haven’t decided are still live — act on them in place, or run /review to relist what remains.',
  'full.gone': 'Submission not found (it may have been erased).',
  'review.attachFail': '⚠️ Could not load this submission’s attachment from Telegram — it may no longer be available.',

  // ---- close / reopen ----
  'close.usage': 'Usage: /close &lt;taskId&gt;',
  'close.ok': (p: { id: number }) => `🔒 Closed #${p.id}.`,
  'reopen.usage': 'Usage: /reopen &lt;taskId&gt;',
  'reopen.ok': (p: { id: number }) => `📢 Reopened #${p.id}.`,
  'task.closeFail': 'Could not close the task.',
  'task.reopenFail': 'Could not reopen the task.',

  // ---- unassign ----
  'unassign.usage': 'Usage: /unassign &lt;applicationId&gt;',

  // ---- forget ----
  'forget.usage': 'Usage: /forget &lt;contributorId&gt; — their Telegram numeric id (shown as "user N" on applicant and review cards; NOT the "id N" application id).',
  'forget.ok': (p: { id: number }) =>
    `🗑️ Erased contributor ${p.id}: profile, applications, and submissions deleted; history anonymized; notifications to or about them purged.`,
  'forget.fail': 'Could not erase the contributor.',

  // ---- privacy ----
  'privacy.text': (p: { ai: boolean; notifRetentionDays: number }) =>
    [
      '🔐 What this bot stores about you',
      '',
      'When you use the bot: your Telegram id, username, display name, and language; your applications and pitches; the work you submit; payouts you are owed for approved work; and, if you link one in the Mini App, your NEAR wallet account. Each task also keeps an action history. People who only read or chat in a group with the bot are not recorded.',
      `Delivery records for notifications are kept for ${p.notifRetentionDays} days, then deleted. Data you erase is removed from the live database immediately; copies in infrastructure backups age out automatically as those backups expire under the configured retention window.`,
      ...(p.ai
        ? [
            'When AI assistance is enabled, submitted text and task briefs are processed by NEAR AI Cloud to draft summaries for reviewers.',
            'In groups where this room’s admins turned signal detection ON (announced in the group; /signalstatus shows it), messages are also processed by NEAR AI Cloud to suggest task drafts. Neither the messages nor their authors are stored — only an anonymous score record; a short window of recent messages is held briefly in memory for context and is never written down.',
            'In groups where AI mode is ON (/ai status shows it), the messages you send there are processed by NEAR AI Cloud so the bot can answer and propose task drafts and applications (which you still confirm by tapping a button). A short conversation history is kept briefly in memory so it can follow up, and is never stored.',
          ]
        : []),
      '',
      'To have everything about you erased, ask any admin — erasure deletes your profile, applications, submissions, payout records, and wallet link, anonymizes history, and purges notification records about you, queued or already delivered. If a payout has already been funded on-chain, erasure waits until you claim it or the treasury revokes it.',
      'One thing erasure cannot reach: claiming a payout writes your NEAR account and the task number to the public NEAR blockchain, permanently. Nothing on-chain names your Telegram identity, and erasure removes the stored link between the two — but the on-chain record itself cannot be deleted.',
    ].join('\n'),

  // ---- status ----
  'status.usage': 'Usage: /status &lt;taskId&gt;',
  'status.notVisible': (p: { id: number }) => `Task #${p.id} not found (or not visible to you).`,
  'status.moreHistory': (p: { shown: number; total: number }) =>
    `…earlier events omitted — showing the latest ${p.shown} of ${p.total}.`,

  // ---- task-announcement DM opt-in ----
  'optin.on': '🔔 On — you’ll get a DM when a new task opens. Turn off with /notify off.',
  'optin.off': '🔕 Off — no task-announcement DMs. Turn on with /notify on.',
  'optin.status': (p: { on: boolean }) =>
    p.on
      ? '🔔 Task-announcement DMs are ON. Use /notify off to stop them.'
      : '🔕 Task-announcement DMs are OFF. Use /notify on to get a DM when a new task opens.',

  // ---- admin overview ----
  'admin.overview': (p: {
    drafts: number;
    open: number;
    applications: number;
    where: string;
    active: number;
    review: number;
    notifQueued: number;
    notifFailed: number;
  }) =>
    [
      '🗂 Admin overview',
      `📝 Drafts awaiting approval: ${p.drafts} → /approve`,
      `📢 Open tasks: ${p.open} → /open`,
      `🙋 Applications awaiting decision: ${p.applications}${p.where} → /applicants &lt;taskId&gt;`,
      `🛠 Assignments in progress: ${p.active} → /active`,
      `📬 Submissions to review: ${p.review} → /review`,
      `📮 Notifications: ${p.notifQueued} pending${p.notifFailed ? `, ⚠️ ${p.notifFailed} failed` : ''}`,
    ].join('\n'),

  // ---- action outcomes ----
  'assign.ok': (p: { taskId: number }) => `✅ Assigned contributor to #${p.taskId}.`,
  'assign.popup': 'Assigned',
  'decline.ok': (p: { taskId: number }) => `🚫 Declined applicant for #${p.taskId}.`,
  'decline.popup': 'Declined',
  'reviewAction.approved': (p: { id: number }) =>
    `✅ Approved submission #${p.id}. The contributor will be notified.`,
  'reviewAction.popup': 'Approved',

  // ---- newtask wizard ----
  'nt.aiHint': ' (or send /ai to let AI draft this)',
  'nt.title': '🆕 New task. What is the title? (send /cancel anytime to abort)',
  'nt.titleText': 'Please send the title as text.',
  'nt.describe': (p: { aiHint: string }) => `Describe the task${p.aiHint}.`,
  'nt.descriptionText': 'Please send the description as text.',
  'nt.reward': 'Reward? (e.g. "100 USDC" — or send "-" for none)',
  'nt.rewardText': 'Please send the reward as text, or "-".',
  'nt.deadline': 'Deadline? (e.g. "YYYY-MM-DD" or "in 3 days" — or "-" for none)',
  'nt.deadlineText': 'Please send the deadline as text, or "-".',
  'nt.output': (p: { aiHint: string }) => `Required output / deliverable?${p.aiHint} Or "-" for none.`,
  'nt.outputText': 'Please send the required output as text, or "-".',
  'nt.maxAssignees': 'How many contributors can be assigned to this task? (a number — send "1" or "-" for a single assignee)',
  'nt.maxAssigneesText': 'Please send a number (or "-" for 1).',
  'nt.maxAssigneesRange': (p: { max: number }) =>
    `Please send a whole number between 1 and ${p.max} (or "-" for 1).`,
  'nt.created': (p: { detail: string }) =>
    `✅ Draft created:\n\n${p.detail}\n\nApprove it with /approve to open it for applications.`,
  'ai.disabledDescription': 'AI assistance is not enabled on this bot — please type a description.',
  'ai.disabledOutput': 'AI assistance is not enabled — please type the required output, or "-".',
  'ai.draftDescriptionWorking': '🤖 Drafting a description… (one moment — please wait for it before sending anything else)',
  'ai.draftOutputWorking': '🤖 Suggesting required output… (one moment — please wait for it before sending anything else)',
  'ai.draftUnavailableDescription': 'AI draft unavailable — please type a description.',
  'ai.draftUnavailableOutput': 'AI suggestion unavailable — please type the required output, or "-".',
  'ai.draftDescriptionResult': (p: { draft: string }) => `Draft description:\n\n${esc(p.draft)}`,
  'ai.draftOutputResult': (p: { draft: string }) => `Suggested required output:\n\n${esc(p.draft)}`,

  // ---- apply wizard ----
  'apply.notOpen': 'That task is not open for applications.',
  'apply.full': (p: { id: number }) =>
    `Task #${p.id} is fully assigned and not accepting applications right now.`,
  'apply.prompt': (p: { id: number; title: string }) =>
    `Applying to #${p.id} "${esc(p.title)}".\nSend a short pitch — why you? (or tap Skip; /cancel to abort)`,
  'apply.pitchText': 'Please send your pitch as text, or tap Skip.',
  'apply.skipButton': '⏭ Apply without a pitch',
  'apply.pitchPlaceholder': 'Type a short pitch, or tap Skip',
  'apply.applied': (p: { id: number }) =>
    `✅ Applied to #${p.id}. An admin will review applicants and assign the task.`,
  'apply.fail': 'Could not apply — please try again.',

  // ---- submit wizard ----
  'sub.notYours': 'That application is not yours.',
  'sub.notAssigned': 'You are not currently assigned to that task.',
  'sub.awaitingReview': 'Your latest submission is still awaiting review.',
  'sub.alreadyApproved': 'This task was already approved. 🎉',
  'sub.prompt': (p: { id: number; title: string }) =>
    `Submit your work for #${p.id}${p.title ? ` "${esc(p.title)}"` : ''}.\nSend text, a link, a file, a screenshot, or a video. (/cancel to abort)`,
  'sub.sendWork': 'Please send text, a link, a file, a screenshot, or a video.',
  'sub.albumNotSupported':
    '⚠️ Albums (multiple photos/videos in one message) aren’t supported — only one item would be recorded. Please send your work as a single message: one photo, video, file, link, or text.',
  'sub.ok': (p: { version: number; taskId: number }) =>
    `✅ Submitted (v${p.version}) for #${p.taskId}. Reviewers will be notified.`,
  'sub.fail': 'Could not submit — please try again.',

  // ---- review-note wizard ----
  'rev.contextLost': 'Review context was lost — please use /review again.',
  'rev.alreadyDecided': (p: { id: number; status: string }) =>
    `Submission #${p.id} is "${p.status}" — it was already decided.`,
  'rev.notePrompt': 'Add a note for the contributor (or tap Skip, /cancel to abort):',
  'rev.noteText': 'Please send a text note, or tap Skip.',
  'rev.skipButton': '⏭ Skip note',
  'rev.notePlaceholder': 'Type a note, or tap Skip',
  'rev.recorded': (p: { id: number; status: string }) =>
    `Recorded: submission #${p.id} → ${p.status}. The contributor will be notified.`,
  'rev.fail': 'Could not record the review.',

  // ---- unassign wizard ----
  'un.notFound': 'Application not found.',
  'un.notAssigned': (p: { status: string }) => `That application is "${p.status}" — only assigned applications can be unassigned.`,
  'un.pendingReview': (p: { version: number }) =>
    `Submission v${p.version} is awaiting review — review it first (/review), then unassign if needed.`,
  'un.reasonPrompt': 'Why are you unassigning this contributor? (a short reason — it is recorded; /cancel to abort)',
  'un.reasonRequired': 'Please send a short reason (it is recorded in the task history).',
  'un.done': '➖ Unassigned. The slot is free and the contributor is back in the applicant pool.',
  'un.fail': 'Could not unassign.',

  // ---- rooms (group chats) & room admins ----
  'rooms.groupOnly': 'This command works inside a group the bot is in — not here.',
  'rooms.roomAdminsOnly': 'Only this room’s admins (or global admins) can do that.',
  'rooms.replyToAdd': 'Reply to a message from the person you want to promote, then send /addroomadmin.',
  'rooms.replyToRemove': 'Reply to a message from the room admin you want to remove, then send /removeroomadmin.',
  'rooms.botCannotBeAdmin': 'A bot cannot be a room admin.',
  'rooms.adminAdded': (p: { name: string }) =>
    `🛡 ${esc(p.name)} is now a room admin for this group — they can manage this room’s tasks via a DM with the bot. (If they haven’t started the bot yet, they should DM it /help first.)`,
  'rooms.alreadyAdmin': (p: { name: string }) => `${esc(p.name)} is already a room admin here.`,
  'rooms.adminRemoved': (p: { name: string }) => `➖ ${esc(p.name)} is no longer a room admin for this group.`,
  'rooms.notAdmin': (p: { name: string }) => `${esc(p.name)} is not a room admin here.`,
  'rooms.adminList': (p: { lines: string }) => `🛡 Room admins for this group:\n${p.lines}`,
  'rooms.noAdmins':
    'No room admins yet. Reply to a user’s message with /addroomadmin to add one (global admins can bootstrap).',

  // ---- signal detection ----
  'signals.needsAi': 'Signal detection needs AI assistance, which is not enabled on this bot.',
  'signals.enabled':
    '🔎 Signal detection is ON for this group: messages here are scored by AI (NEAR AI Cloud) to suggest task drafts, which admins review before anything opens. Messages and their authors are not stored. /disablesignals turns it off; /signalstatus shows status.',
  'signals.disabled': '🔕 Signal detection is OFF for this group.',
  'signals.status': (p: { on: boolean; drafted: number; discarded: number }) =>
    p.on
      ? `🔎 Signal detection is ON for this group (so far: ${p.drafted} drafted, ${p.discarded} discarded). Messages are AI-scored to suggest task drafts; messages and authors are not stored. /disablesignals turns it off.`
      : `🔕 Signal detection is OFF for this group. A room admin can turn it on with /enablesignals.`,

  // ---- conversational AI mode ----
  'ai.needsAi': 'AI mode needs AI assistance, which is not enabled on this bot.',
  'ai.on':
    '💬 AI mode is ON for this group: mention me (@…) or reply to my messages to browse tasks, apply, or (admins) draft tasks. I propose — you still tap to confirm. Messages you address to me go to the AI (NEAR AI Cloud) to answer; conversation context is kept briefly in memory, not stored. Other chatter is untouched (unless signal detection is also on). /ai off turns it off.',
  'ai.off': '💬 AI mode is OFF for this group.',
  'ai.usage': 'Usage: /ai on | off | status',
  'ai.status': (p: { on: boolean }) =>
    p.on
      ? '💬 AI mode is ON for this group: mention me (@…) or reply to my messages. /ai off turns it off.'
      : '💬 AI mode is OFF for this group. A room admin can turn it on with /ai on.',

  // ---- /settings panel ----
  'settings.groupHeader': '⚙️ Group settings — a room admin can toggle these:',
  'settings.signalsLine': (p: { on: boolean; drafted: number; discarded: number }) =>
    p.on ? `🔎 Signal detection: ON (${p.drafted} drafted, ${p.discarded} discarded)` : '🔎 Signal detection: OFF',
  'settings.aiLine': (p: { on: boolean }) => `💬 AI mode: ${p.on ? 'ON' : 'OFF'}`,
  'settings.notifyLine': (p: { on: boolean }) =>
    p.on ? '🔔 Task-announcement DMs: ON' : '🔕 Task-announcement DMs: OFF',
  'btn.signalsOn': '🔎 Turn signals on',
  'btn.signalsOff': '🔕 Turn signals off',
  'btn.aiModeOn': '💬 Turn AI mode on',
  'btn.aiModeOff': '💬 Turn AI mode off',
  'btn.notifyOn': '🔔 Turn DMs on',
  'btn.notifyOff': '🔕 Turn DMs off',

  // ---- payouts (escrow funding queue, admin) ----
  'payouts.none': '💰 No payouts awaiting funding or claim right now.',
  'payouts.title': '💰 Payouts — funding queue',
  'payouts.needsWallet': '⚠️ No NEAR wallet linked yet — the contributor links one in the Mini App, then this can be funded.',
  'payouts.fundHint': 'Fund it with the treasury key (set the amount):',
  'payouts.checkFailed': '⚠️ Couldn’t read its on-chain status just now (RPC error) — re-run /payouts. Not showing a fund command, to avoid double-funding.',
  'payouts.funded': (p: { account: string; amount: string }) =>
    `✅ Funded on-chain (${esc(p.amount)} NEAR) → <code>${esc(p.account)}</code> can claim it in the Mini App.`,
  'payouts.claimed': '🏁 Claimed.',
  'payouts.revoked': '↩️ Revoked — the funds went back to the treasury (not paid).',

  // ---- shared manageability errors (room-aware admin commands) ----
  'task.notManageable': (p: { id: number }) => `Task #${p.id} not found (or not yours to manage).`,
  'app.notManageable': (p: { id: number }) => `Application #${p.id} not found (or not yours to manage).`,

  // ---- notifications ----
  'notify.signalDraft': (p: { line: string; room: string | null }) =>
    `🔎 Signal detection drafted a task from${p.room ? ` "${esc(p.room)}"` : ' a group'}:\n${p.line}\n\nReview it with /approve (or leave it as a draft).`,
  'notify.roomRegistered': (p: { title: string | null; chatId: number; inviterId: number | null }) =>
    `👥 The bot was added to the group ${p.title ? `"${esc(p.title)}"` : String(p.chatId)}${
      p.inviterId !== null ? ` by user ${p.inviterId}, who is now that room’s first admin` : ''
    }.\nA room admin can enable AI task drafts there with /enablesignals, and add more room admins with /addroomadmin (as a reply to their message).`,
  'notify.roomAdminPromoted': (p: { title: string | null }) =>
    `🛡 You’re now a room admin${p.title ? ` for "${esc(p.title)}"` : ''}. You can approve, assign, and review that room’s tasks — send /help to see your commands.`,
  'notify.reviewHeader': (p: { card: string }) => `📬 New submission for review\n\n${p.card}`,
  'notify.reviewAiNote': (p: { taskId: number; version: number; note: string }) =>
    `🤖 AI note on submission v${p.version} for task #${p.taskId}:\n${esc(p.note)}`,
  'notify.reviewApproved': (p: TaskRef & { reward: string | null; note: string | null }) =>
    `✅ Your submission for ${yourTask(p)} was approved!${p.reward ? ` Reward: ${esc(p.reward)}.` : ''}${noteLine(p.note)}`,
  'notify.reviewRejected': (p: TaskRef & { note: string | null }) =>
    `❌ Your submission for ${yourTask(p)} was rejected and this assignment is closed.${noteLine(p.note)}\n\nBrowse /open for other tasks.`,
  'notify.reviewRevise': (p: TaskRef & { note: string | null }) =>
    `🔁 Your submission for ${yourTask(p)} needs revision.${noteLine(p.note)}\n\nUse /myapps to submit a new version.`,
  'notify.assigned': (p: TaskRef) =>
    `🎉 You've been assigned to ${aTask(p)}! Use /myapps to submit your work.`,
  'notify.declined': (p: TaskRef) =>
    `🚫 Your application for ${aTask(p)} wasn't selected this time. Thanks for applying — see /open for more.`,
  'notify.unassigned': (p: TaskRef & { reason: string }) =>
    `➖ You were unassigned from ${aTask(p)}${p.reason ? ` — ${esc(p.reason)}` : ''}. Your application is back in the pool.`,
  'notify.announceChat': (p: { line: string }) =>
    `📢 New task open for applications:\n${p.line}\n\nDM the bot and send /open to apply.`,
  'notify.announceRoom': (p: { line: string }) =>
    `📢 A task from this group is now open:\n${p.line}\n\nApply below, or DM the bot and send /open.`,
  'notify.announceDm': (p: { line: string }) =>
    `🆕 A new task may interest you:\n${p.line}\n\nUse /open to view and apply. (/notify off to stop these)`,
  'notify.newApplication': (p: { header: string; card: string }) => `${p.header}\n\n${p.card}`,
  'notify.applicationHeaderTask': (p: { line: string }) => `🙋 New application for ${p.line}`,
  'notify.applicationHeaderId': (p: { id: number }) => `🙋 New application for task #${p.id}`,
  'notify.submissionCaption': (p: { version: number; caption: string }) =>
    `Submission v${p.version}${p.caption ? ` — ${esc(p.caption)}` : ''}`,

  // NOTE: the card field-labels in src/bot/format.ts intentionally do NOT route
  // through this catalog yet (see README "Internationalization") — add their
  // keys here only together with the formatter change that consumes them.
} as const;
