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
// Optional deep link to a DAO proposal in the operator's governance UI
// (config.daoProposalUrl) — appended to the payout rows that ask a human to go
// vote/verify there. Escaped: a URL's '&' would otherwise 400 the HTML send.
const urlLine = (url: string | null) => (url ? `\n🔗 ${esc(url)}` : '');
// Queue-age tag for the /admin overview: shown only when something has waited
// a day or more — same-day queues don't need an urgency label.
const ageTag = (days: number | null) => (days != null && days >= 1 ? ` (oldest ${days}d)` : '');
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
  'common.dmLost':
    '🤔 I didn’t recognize that. If you were mid-step (applying, submitting), a restart may have cleared it — start again from /open or /myapps. /help lists everything I can do.',
  'btn.prev': '◀ Prev',
  'btn.next': 'Next ▶',
  'inline.openTask': 'Open task — tap to share',
  'common.nothingToCancel': 'Nothing to cancel.',
  'common.cancelled': 'Cancelled.',
  'list.more': (p: { shown: number; total: number }) => `…showing the first ${p.shown} of ${p.total}.`,

  // ---- inline keyboard buttons ----
  'btn.apply': (p: { id: number }) => `🙋 Apply to #${p.id}`,
  'btn.approveOpen': (p: { id: number }) => `✅ Approve & open #${p.id}`,
  'btn.discard': (p: { id: number }) => `🗑 Discard #${p.id}`,
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
  // Cold /start: an orientation, not a command manifest — what this is, the
  // three-step loop, and that approved work pays. The reference card stays on
  // /help; a deep-linked /start (?start=t<id>) skips this into the apply flow.
  'start.welcome': (p: { dao: boolean }) =>
    [
      '👋 Welcome! This is a task board where approved work earns a reward.',
      '',
      'How it works:',
      '1. Browse open tasks with /open and apply with a short pitch.',
      '2. If an admin assigns you the task, submit your work via /myapps.',
      `3. A reviewer approves it — rewarded work lands in /payouts${
        p.dao ? ', paid to the NEAR account you set with /payto' : ''
      }.`,
      '',
      '🔔 Want new tasks to come to you? Turn on DMs: /notify on',
      '/help lists every command · /privacy explains what’s stored about you',
    ].join('\n'),
  'help.text': (p: { admin: boolean; roomAdmin: boolean; ai: boolean; dao: boolean; support: string | null }): string => {
    const contributor = [
      '👋 MultiAgency contributor bot',
      '',
      'Contributor commands:',
      '/open — browse open tasks and apply',
      '/myapps — your applications; submit assigned work',
      '/submit &lt;applicationId&gt; — submit work for an assignment',
      '/withdraw &lt;applicationId&gt; — withdraw an application',
      '/notify on|off — task-announcement DMs (off by default)',
      '/settings — your notification settings (one-tap toggle)',
      ...(p.dao
        ? [
            '/payto &lt;your.near&gt; — set the NEAR account your payouts go to',
            '/payouts — your payouts: the status of money owed to you',
          ]
        : []),
      '/status &lt;taskId&gt; — a task and its history',
      '/privacy — what this bot stores about you · /terms — the deal, plainly',
      '/forgetme — ask the operators to erase everything about you',
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
      ...(p.admin
        ? [
            '/payouts — the funding queue: payouts owed for approved rewarded work',
            ...(p.dao ? ['/pay &lt;taskId&gt; &lt;amountNEAR&gt; [recipient.near] — propose a DAO payout for a task'] : []),
            '/stats — the funnel at a glance · /diag — config preflight',
            '/forget &lt;contributorId&gt; — erase a contributor’s data',
          ]
        : []),
    ];
    // Group surface for EVERYONE, not just managers: whether a group is scanned
    // or answering (/signalstatus, /ai status, /settings) is every member's
    // business, and hiding the group commands from members made the group
    // product undiscoverable.
    const footer = [
      '',
      'In a group I’m in: /open, /status, /settings, /signalstatus and /ai status work for everyone; room admins also get /enablesignals, /disablesignals, /ai on|off, and /addroomadmin, /removeroomadmin, /roomadmins (reply to a message to pick the person).',
      '/cancel — abort the current step',
      p.ai ? '🤖 AI drafting is enabled.' : '',
      ...(p.support ? [`💬 Stuck, or a payout question? Contact ${esc(p.support)}.`] : []),
    ];
    return [...contributor, ...(p.admin || p.roomAdmin ? manager : []), ...footer].join('\n');
  },

  // ---- task creation & approval ----
  'approve.none': 'No draft tasks awaiting approval.',
  'approve.count': (p: { n: number }) => `📝 ${p.n} draft task(s):`,
  'approve.opened': (p: { detail: string }) => `✅ Approved &amp; opened:\n\n${p.detail}`,
  'approve.popup': 'Opened!',
  'approve.discarded': (p: { id: number }) => `🗑 Draft #${p.id} discarded — nothing was announced.`,
  'approve.discardPopup': 'Discarded.',

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
  'privacy.text': (p: { ai: boolean; notifRetentionDays: number; support: string | null }) =>
    [
      '🔐 What this bot stores about you',
      '',
      'When you use the bot: your Telegram id, username, display name, and language; your applications and pitches; the work you submit; payouts you are owed for approved work; and, if you set one, the NEAR account where you want those payouts sent. Each task also keeps an action history. People who only read or chat in a group with the bot are not recorded — with one exception: if someone promotes you to room admin (/addroomadmin), your Telegram id and name are stored so the bot can route that room’s admin duties to you; erasure removes that too.',
      `Delivery records for notifications are kept for ${p.notifRetentionDays} days, then deleted. Data you erase is removed from the live database immediately; copies in infrastructure backups age out automatically as those backups expire under the configured retention window.`,
      ...(p.ai
        ? [
            'When AI assistance is enabled, submitted text and task briefs are processed by NEAR AI Cloud to draft summaries for reviewers.',
            'In groups where this room’s admins turned signal detection ON (announced in the group; /signalstatus shows it), messages are also processed by NEAR AI Cloud to suggest task drafts. Neither the messages nor their authors are stored — only an anonymous score record; a short window of recent messages is held briefly in memory for context and is never written down.',
            'In groups where AI mode is ON (/ai status shows it), the messages you send there are processed by NEAR AI Cloud so the bot can answer and propose task drafts and applications (which you still confirm by tapping a button). A short conversation history is kept briefly in memory so it can follow up, and is never stored.',
          ]
        : []),
      '',
      'To have everything about you erased, send /forgetme here — it files the request with the operators (erasure is run by a human admin). Erasure deletes your profile, applications, submissions, payout records, and your saved payout account, anonymizes history, and purges notification records about you, queued or already delivered. If a payout proposal is open on the DAO, erasure waits until the council approves or rejects it.',
      'One thing erasure cannot reach: proposing a payout writes your NEAR account and the task number to the public NEAR blockchain, permanently. Nothing on-chain names your Telegram identity, and erasure removes the stored link between the two — but the on-chain record itself cannot be deleted.',
      'To submit that proposal, the treasury may use a third-party signing service (OutLayer): it receives the same public proposal details (your payout account, the task, the amount) and signs on the treasury’s behalf in a secure enclave. The bot never holds a key that can move funds.',
      ...(p.support ? ['', `Questions, or a request the commands don’t cover? Contact ${esc(p.support)}.`] : []),
    ].join('\n'),

  // ---- /terms — the deal, stated plainly (the money/authority half of the
  // trust model /privacy covers the data half of) ----
  'terms.text': (p: { dao: boolean; support: string | null }) =>
    [
      '📜 Terms of use (plain language)',
      '',
      '• Tasks are posted and curated by this bot’s operators and their room admins. Applying, being assigned, and having work approved are human decisions — the bot only coordinates them.',
      `• Rewards are stated on each task. ${
        p.dao
          ? 'Payment is released only by a vote of the operator’s treasury council (a NEAR DAO), and the council’s decision on a payment is final. Approved work whose proposal is voted down stays recorded as owed and can be re-proposed.'
          : 'Payment is settled directly by the operators.'
      }`,
      '• Completing a task creates no employment or agency relationship with the operators.',
      '• The operators may close, reopen, or remove tasks, and decline or unassign applications — reasons land in the task history (/status).',
      '• What’s stored about you, and erasure: /privacy (request erasure any time with /forgetme).',
      '• The service is provided as-is, without warranties.',
      ...(p.support ? ['', `Disputes or questions: contact ${esc(p.support)}.`] : []),
      '',
      'This is the operators’ plain-language summary of the arrangement, not a negotiated contract.',
    ].join('\n'),

  // ---- /forgetme (contributor-initiated erasure request) ----
  'forgetme.confirm':
    '🗑 This asks the operators to erase everything about you — profile, applications, submissions, payout records. Erasure is run by a human admin and waits for any in-flight payout (see /privacy). Send the request?',
  'forgetme.requested':
    '✅ Request sent to the operators. A human admin runs the erasure — if you have an open payout, it completes after the council settles it. You can keep using the bot meanwhile; using it again after erasure re-registers you.',
  'forgetme.popup': 'Request sent.',
  'notify.erasureRequest': (p: { contributorId: number; username: string | null }) =>
    `🗑 Erasure request from contributor <code>${p.contributorId}</code>${
      p.username ? ` (@${esc(p.username)})` : ''
    } — run /forget ${p.contributorId} (the money-in-flight guard applies as usual).`,

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
    stale: number;
    staleDays: number;
    review: number;
    notifQueued: number;
    notifFailed: number;
    oldestApplicationDays: number | null;
    oldestReviewDays: number | null;
  }) =>
    [
      '🗂 Admin overview',
      `📝 Drafts awaiting approval: ${p.drafts} → /approve`,
      `📢 Open tasks: ${p.open} → /open`,
      // The two queues where a CONTRIBUTOR is waiting on an admin carry the age
      // of their oldest row — volume says how much, age says how urgently.
      `🙋 Applications awaiting decision: ${p.applications}${p.where}${ageTag(p.oldestApplicationDays)} → /applicants &lt;taskId&gt;`,
      `🛠 Assignments in progress: ${p.active} → /active`,
      // Claim-and-abandon surfacing: a held slot with no submission activity
      // blocks other contributors until someone acts.
      ...(p.stale > 0 ? [`⏱ Stale (no submission in ${p.staleDays}d): ${p.stale} → /active, then /unassign`] : []),
      `📬 Submissions to review: ${p.review}${ageTag(p.oldestReviewDays)} → /review`,
      `📮 Notifications: ${p.notifQueued} pending${p.notifFailed ? `, ⚠️ ${p.notifFailed} failed` : ''}`,
    ].join('\n'),

  // ---- /stats (admin): the funnel at a glance ----
  'stats.overview': (p: {
    contributors: number;
    applicants: number;
    activationPct: number | null;
    tasksTotal: number;
    tasksOpen: number;
    applications: number;
    inProgress: number;
    completed: number;
    payoutsPaid: number;
    payoutsOwed: number;
  }) =>
    [
      '📈 Product stats (all-time)',
      `👥 Contributors: ${p.contributors}${
        p.activationPct != null ? ` — ${p.applicants} ever applied (${p.activationPct}% activation)` : ''
      }`,
      `🗂 Tasks: ${p.tasksTotal} created · ${p.tasksOpen} open now`,
      `🙋 Applications: ${p.applications} · 🛠 in progress: ${p.inProgress} · ✅ completed: ${p.completed}`,
      `💰 Payouts: ${p.payoutsPaid} paid · ${p.payoutsOwed} owed`,
    ].join('\n'),

  // ---- /diag (admin): config preflight — is this instance actually wired? ----
  'diag.title': '🩺 Diagnostics',
  'diag.db': (p: { ok: boolean }) => (p.ok ? '✅ Database reachable' : '❌ Database unreachable'),
  'diag.admins': (p: { n: number }) =>
    p.n > 0 ? `✅ Global admins: ${p.n}` : '⚠️ ADMIN_IDS is empty — nobody can create, approve, or review',
  'diag.announceOk': (p: { title: string }) => `✅ Announce chat reachable${p.title ? ` (${esc(p.title)})` : ''}`,
  'diag.announceMissing':
    '⚠️ No ANNOUNCE_CHAT_ID — new global tasks are announced nowhere; contributors must poll /open (opt-in DMs still go out)',
  'diag.announceFail': (p: { error: string }) =>
    `❌ Announce chat unreachable (${esc(p.error)}) — approvals will “succeed” with nobody seeing the announcement`,
  'diag.privacyOn':
    'ℹ️ Group privacy mode is ON — signal detection / @mention AI need the bot promoted to admin in each scanned group',
  'diag.privacyOff': 'ℹ️ Group privacy mode is OFF — the bot receives all group messages everywhere it sits',
  'diag.daoOk': (p: { dao: string; ms: number }) => `✅ DAO <code>${esc(p.dao)}</code> reachable (${p.ms}ms)`,
  'diag.daoOff': 'ℹ️ DAO rail off (no DAO_CONTRACT_ID) — payouts are recorded and settled off-platform',
  'diag.daoFail': (p: { dao: string; error: string }) =>
    `❌ DAO <code>${esc(p.dao)}</code> unreachable: ${esc(p.error)} — settlement statuses can’t be read`,
  'diag.outlayerOn': '✅ OutLayer key present — /pay can propose (key validity is proven by the first real /pay)',
  'diag.outlayerOff': (p: { daoOn: boolean }) =>
    p.daoOn
      ? '⚠️ No OUTLAYER_API_KEY — the DAO is configured but nothing can propose; /pay will refuse'
      : 'ℹ️ OutLayer off (no DAO rail to propose to)',
  'diag.webOn': (p: { url: string }) =>
    `✅ Web tier on${p.url ? ` — ${esc(p.url)}` : ' (no WEB_APP_URL: Mini App menu buttons stay off)'}`,
  'diag.webOff': 'ℹ️ Web tier off (no PORT/WEB_PORT) — bot-only deployment, /healthz unavailable',
  'diag.aiOn': '✅ AI enabled',
  'diag.aiOff': 'ℹ️ AI off (no NEAR_AI_API_KEY) — drafting, summaries, signals, and agent mode disabled',

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
  'nt.fail': 'Could not create the task.',
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
  'apply.notOpen': 'That task is not open for applications. Browse /open for ones that are.',
  'apply.full': (p: { id: number }) =>
    `Task #${p.id} is fully assigned and not accepting applications right now. Browse /open for ones still looking.`,
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
  'rooms.welcome': (p: { username: string | null }) =>
    [
      '👋 Thanks for adding me! I help this group turn its discussions into tasks — and contributors get paid for approved work.',
      '',
      'Quick start (whoever added me is this room’s first admin):',
      '• /settings — turn on signal detection (AI drafts tasks from the chat) or AI mode (talk to me by @mention)',
      '• Both need me to actually see messages: make me a group admin here, or turn off my privacy mode in @BotFather',
      '• /open — browse this room’s open tasks; /addroomadmin (as a reply to someone) adds more room admins',
      '',
      `Room admins manage this group’s tasks in a private chat with me${p.username ? ` (@${p.username})` : ''} — send /help there to see everything.`,
    ].join('\n'),
  'rooms.receiveWarning':
    '⚠️ Heads-up: I can’t currently see regular messages in this group, so this will stay silent. Fix: make me a group admin here, or turn off my privacy mode in @BotFather (Bot Settings → Group Privacy) and re-add me.',

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
  'btn.forgetme': '🗑 Yes, request erasure',

  // ---- payouts (DAO payout queue, admin) ----
  'payouts.none': '💰 No payouts awaiting payment right now.',
  'payouts.title': '💰 Payouts — DAO queue',
  'payouts.offPlatform':
    '📒 On-chain settlement is not configured — this stays on the ledger as owed; settle it off-platform (or set DAO_CONTRACT_ID to pay from here).',
  'payouts.checkFailed': '⚠️ Couldn’t read its DAO proposal status just now (RPC error) — re-run /payouts. Not showing a pay action, to avoid double-paying.',
  'payouts.claimHeld':
    '⏳ A proposal was submitted for this payout but isn’t visible on-chain yet — it confirms here once it lands, or the claim auto-clears back to the queue within minutes.',
  'payouts.paid': '💸 Paid — the DAO approved the proposal and transferred the funds.',
  'payouts.proposed': (p: { proposalId: number | null; url: string | null }) =>
    `🗳 DAO proposal${p.proposalId != null ? ` #<code>${p.proposalId}</code>` : ''} open — awaiting an Approver vote. ` +
    `The vote IS the payment control: verify recipient + amount against this row before approving.${urlLine(p.url)}`,
  'payouts.proposalStuck': (p: { proposalId: number | null; url: string | null }) =>
    `⚠️ Proposal${p.proposalId != null ? ` #<code>${p.proposalId}</code>` : ''} was APPROVED but the transfer FAILED ` +
    `(treasury balance?) — top up the treasury and re-finalize it in the DAO.${urlLine(p.url)}`,
  'payouts.duplicate': (p: { proposalId: number | null; url: string | null }) =>
    `⚠️ MORE THAN ONE live proposal carries this exact transfer (one proposed out-of-band alongside the bot’s)${
      p.proposalId != null ? ` — the ledger tracks #<code>${p.proposalId}</code>` : ''
    }. Have the council reject the extra one before voting, or both could pay.${urlLine(p.url)}`,
  'payouts.payHint': (p: { taskId: number }) =>
    `Propose it through the DAO: <code>/pay ${p.taskId} &lt;amount NEAR&gt;</code>`,
  // A pending row the admin can't act on yet — the funnel leak surfaced where
  // the admin looks, instead of being discovered by a refused /pay.
  'payouts.noAccount': (p: { taskId: number }) =>
    `⛔ Blocked on the contributor: no payout account saved (their approval DM nudged /payto — nudge again). ` +
    `Or pay a known account directly: <code>/pay ${p.taskId} &lt;amount NEAR&gt; &lt;recipient.near&gt;</code>`,
  'payouts.requeued': (p: { taskId: number }) =>
    `🚫 The council voted its last proposal down — check the amount and recipient before re-proposing: <code>/pay ${p.taskId} &lt;amount NEAR&gt;</code>`,
  // ---- /payouts (contributor mode: their own money, contributor-toned) ----
  'payouts.mineHeader': '💰 Your payouts:',
  'payouts.mineNone': 'No payouts on record for you yet — approved work with a reward shows up here.',
  'payouts.mineLine': (p: { taskId: number; title: string | null; reward: string; amountNear: string | null; status: string }) =>
    `#${p.taskId}${p.title ? ` "${esc(p.title)}"` : ''} — 🎁 ${esc(p.reward)}${
      p.amountNear ? ` · ◈ ${p.amountNear} NEAR` : ''
    } · ${p.status}`,
  'payouts.mineStatus.paid': '💸 paid',
  'payouts.mineStatus.proposed': '🗳 DAO proposal open — the council’s approval releases it',
  'payouts.mineStatus.pending': '⏳ queued — an admin proposes it to the DAO next',
  'payouts.mineStatus.attention': '⚠️ held up — an admin is on it (ask them if it lingers)',
  'payouts.mineStatus.checkFailed': '❓ couldn’t check on-chain just now — try again in a moment',
  // A young claim whose proposal hasn't confirmed yet — benign, not an error
  // (the admin surface's claimHeld twin; without this the contributor reads a
  // routine in-flight moment as "couldn't check").
  'payouts.mineStatus.held': '⏳ payment proposal in flight — check back in a few minutes',
  // The dormant-rail truth: no DAO is configured, so nothing will be "proposed
  // next" — money owed is settled by the operators directly.
  'payouts.mineStatus.recorded': '📒 recorded — the operators settle this with you directly',
  // Who releases the money, said once per view — "the council" appears in the
  // row statuses and is otherwise never explained to someone new to DAOs.
  'payouts.mineCouncilNote': (p: { support: string | null }) =>
    `ℹ️ Payments are released by a vote of the operator’s treasury council (a NEAR DAO) — usually within the proposal’s voting window.${
      p.support ? ` Questions about a payout? Contact ${esc(p.support)}.` : ''
    }`,

  // One pending payout per task is the /pay contract.
  'payouts.noneForTask': (p: { taskId: number }) => `No pending payout for task #${p.taskId}.`,
  'payouts.multipleForTask': (p: { taskId: number; count: number }) =>
    `Task #${p.taskId} has ${p.count} pending payouts (multiple assignees) — not supported here yet.`,

  // ---- /pay (admin) ----
  'pay.notEnabled': 'DAO payouts are not enabled (set DAO_CONTRACT_ID).',
  'pay.usage':
    'Usage: <code>/pay &lt;taskId&gt; &lt;amountNEAR&gt; [recipient.near]</code>\n' +
    'Omit the recipient to use the contributor’s saved account. Example: <code>/pay 7 0.5</code>',
  'pay.badAmount': 'Amount must be a positive NEAR number, e.g. 0.5',
  'pay.noRecipient': (p: { taskId: number; amount: string }) =>
    `No recipient — the contributor hasn't saved a payout account. Pass one: <code>/pay ${p.taskId} ${esc(p.amount)} &lt;recipient.near&gt;</code>`,
  'pay.proposed': (p: { taskId: number; amount: string; account: string; reward: string; proposalId: number; url: string | null }) =>
    `✅ Proposed payout for task #<code>${p.taskId}</code>: ${esc(p.amount)} NEAR → <code>${esc(p.account)}</code>\n` +
    `Advertised reward was 🎁 ${esc(p.reward)} — eyeball the conversion.\n` +
    `DAO proposal #<code>${p.proposalId}</code> — an Approver must verify recipient + amount, then vote to release the funds.${urlLine(p.url)}`,
  'pay.submitted': (p: { taskId: number; amount: string; account: string; reward: string }) =>
    `✅ Submitted a payout proposal for task #<code>${p.taskId}</code>: ${esc(p.amount)} NEAR → <code>${esc(p.account)}</code>\n` +
    `Advertised reward was 🎁 ${esc(p.reward)} — eyeball the conversion.\n` +
    `Run /payouts in a moment to confirm it landed and pin its proposal id.`,
  'pay.fail': 'Could not propose the payout.',

  // ---- /payto (contributor) ----
  'payto.notEnabled': 'Payouts are not enabled here.',
  'payto.disclosure':
    'When you’re paid, this account and the task id appear on the public NEAR chain permanently — beyond erasure.',
  'payto.current': (p: { account: string }) =>
    `Your payout account is <code>${esc(p.account)}</code>.\nChange it: <code>/payto &lt;your.near&gt;</code>`,
  'payto.prompt': 'Set the NEAR account your payouts go to: <code>/payto &lt;your.near&gt;</code>',
  'payto.ok': (p: { account: string }) => `✅ Payouts will go to <code>${esc(p.account)}</code>.`,
  'payto.fail': 'Could not set your payout account.',

  'notify.payoutPaid': (p: { taskId: number; account: string | null }) =>
    `💸 Your payout for task #${p.taskId} was approved and sent${
      p.account ? ` to <code>${esc(p.account)}</code>` : ''
    }. 🎉`,
  // The approval→payment funnel link: appended to an approval DM (and shown by
  // /payouts) when rewarded work has nowhere to be paid yet.
  'notify.paytoNudge':
    '💡 To receive rewards on-chain, set your payout account: <code>/payto your.near</code> — payouts can’t be sent without one. No NEAR account yet? Create one free with a NEAR wallet (e.g. Meteor Wallet or MyNearWallet), then set it here. /payouts shows where your money stands.',

  // ---- conversational agent (group /ai mode) ----
  'agent.budget': '⏳ This group’s hourly AI budget is spent — the assistant will answer again in a while.',

  // ---- shared manageability errors (room-aware admin commands) ----
  'task.notManageable': (p: { id: number }) => `Task #${p.id} not found (or not yours to manage).`,
  'app.notManageable': (p: { id: number }) => `Application #${p.id} not found (or not yours to manage).`,

  // ---- notifications ----
  'notify.signalDraft': (p: { detail: string; room: string | null }) =>
    `🔎 Signal detection drafted a task from${p.room ? ` "${esc(p.room)}"` : ' a group'}:\n\n${p.detail}\n\nTap to approve &amp; open it — or leave it as a draft (/approve lists everything waiting).`,
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
    `❌ Your submission for ${yourTask(p)} wasn’t accepted, and this assignment is now closed.${noteLine(p.note)}\n\nThat happens — thanks for the work you put in. /open has more tasks when you’re ready.`,
  'notify.reviewRevise': (p: TaskRef & { note: string | null }) =>
    `🔁 Your submission for ${yourTask(p)} needs revision.${noteLine(p.note)}\n\nUse /myapps to submit a new version.`,
  'notify.assigned': (p: TaskRef) =>
    `🎉 You've been assigned to ${aTask(p)}! Use /myapps to submit your work.`,
  // Waiting-state honesty: applicants hear when the shape of their wait changes
  // (see notifyApplicantsTaskChanged), not only when they're picked or passed on.
  'notify.taskFilled': (p: TaskRef) =>
    `ℹ️ ${aTask(p)} just filled its last slot. Your application stays in the pool — a slot can free up, and you'll be notified of any decision. Meanwhile, /open has more tasks.`,
  'notify.taskClosed': (p: TaskRef) =>
    `📕 ${aTask(p)} was closed before your application was decided. You're still in the pool if it reopens — meanwhile, browse /open.`,
  // The pre-stale nudge (worker sweep): a fair warning BEFORE the assignment
  // shows up stale on /admin and risks an /unassign.
  'notify.staleNudge': (p: TaskRef & { days: number }) =>
    `⏳ You were assigned to ${aTask(p)} ${p.days}+ days ago and nothing has been submitted yet. Still on it? /myapps has the Submit button — or /withdraw frees the slot if plans changed.`,
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
  // Ops alert to global admins: the delivery worker exhausted a notification's
  // retries on a transient error (throttled — alsoCount summarizes the rest).
  'notify.opsGiveUp': (p: { notificationId: number; attempts: number; error: string; alsoCount: number }) =>
    `🚨 Notification delivery is failing: #${p.notificationId} gave up after ${p.attempts} attempt(s) — ${esc(p.error)}${
      p.alsoCount > 0 ? ` (${p.alsoCount} more gave up recently)` : ''
    }. Check /admin and the deploy logs.`,

  // NOTE: the card field-labels in src/bot/format.ts intentionally do NOT route
  // through this catalog yet (see README "Internationalization") — add their
  // keys here only together with the formatter change that consumes them.
} as const;
