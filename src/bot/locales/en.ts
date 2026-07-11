/**
 * English catalog — the single source of truth for the bot's user-facing chrome.
 * Entries are either a plain string or a function of interpolation params.
 * A future locale is a copy of this file with translated values (same keys).
 */

// Locale-internal helpers for the notify.* entries: the task reference (with a
// translatable fallback when the task row is gone) and the optional note line.
// A translated catalog brings its own versions.
type TaskRef = { taskId: number | null; title: string };
const yourTask = (p: TaskRef) => (p.taskId === null ? 'your task' : `#${p.taskId} "${p.title}"`);
const aTask = (p: TaskRef) => (p.taskId === null ? 'a task' : `#${p.taskId} "${p.title}"`);
const noteLine = (note: string | null) => (note ? `\n\n📝 Note: ${note}` : '');
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
      '/submit <applicationId> — submit work for an assignment',
      '/withdraw <applicationId> — withdraw an application',
      '/notify on|off — task-announcement DMs (off by default)',
      '/status <taskId> — a task and its history',
      '/privacy — what this bot stores about you',
    ];
    // Room admins get the task-management commands, scoped to their rooms' tasks.
    const managerScope = p.admin ? '' : ' (your rooms’ tasks)';
    const manager = [
      '',
      p.admin ? 'Admin commands:' : `Room-admin commands${managerScope}:`,
      ...(p.admin ? ['/admin — overview: what needs you, and where', '/newtask — create a task (set max assignees)'] : []),
      '/approve — approve draft tasks',
      '/applicants <taskId> — review applicants; assign or decline',
      '/active — assignments in progress',
      '/review — review submitted work',
      '/close <taskId> — stop accepting applications',
      '/reopen <taskId> — reopen for applications',
      '/unassign <applicationId> — remove an assignment (records a reason)',
      ...(p.admin ? ['/forget <contributorId> — erase a contributor’s data'] : []),
      '',
      'In a group the bot is in: /enablesignals, /disablesignals, /signalstatus (AI task drafts from chat), and /addroomadmin, /removeroomadmin, /roomadmins (reply to a message to pick the person).',
    ];
    const footer = ['', '/cancel — abort the current step', p.ai ? '🤖 AI drafting is enabled.' : ''];
    return [...contributor, ...(p.admin || p.roomAdmin ? manager : []), ...footer].join('\n');
  },

  // ---- task creation & approval ----
  'approve.none': 'No draft tasks awaiting approval.',
  'approve.count': (p: { n: number }) => `📝 ${p.n} draft task(s):`,
  'approve.opened': (p: { detail: string }) => `✅ Approved & opened:\n\n${p.detail}`,
  'approve.popup': 'Opened!',

  // ---- open & apply ----
  'open.none': 'No open tasks right now. Check back soon!',
  'open.count': (p: { n: number }) => `📢 ${p.n} open task(s) — apply to any:`,
  'open.fullyAssigned': (p: { detail: string }) =>
    `${p.detail}\n\n✅ Fully assigned — not accepting applications.`,
  'open.more': (p: { shown: number; total: number }) =>
    `…showing the first ${p.shown} of ${p.total} open tasks. New tasks are announced in the channel; /status <taskId> shows any task.`,

  // ---- myapps ----
  'myapps.none': 'You have no applications yet. Browse /open.',

  // ---- submit ----
  'submit.usage': 'Usage: /submit <applicationId> — the "id" number shown on your /myapps rows.',
  'submit.none': 'You have no assigned tasks to submit. See /myapps.',
  'submit.which': 'Which assignment are you submitting? Tap one:',

  // ---- withdraw ----
  'withdraw.usage': 'Usage: /withdraw <applicationId> — the "id" number shown on your /myapps rows.',
  'withdraw.ok': (p: { taskId: number }) => `↩️ Withdrew your application for #${p.taskId}.`,
  'withdraw.fail': 'Could not withdraw.',
  'withdraw.popup': 'Withdrawn',

  // ---- applicants ----
  'applicants.usage': 'Usage: /applicants <taskId>',
  'applicants.header': (p: { id: number; title: string; assigned: number; max: number; n: number }) =>
    `👥 Task #${p.id} "${p.title}" — ${p.assigned}/${p.max} assigned, ${p.n} awaiting decision:`,

  // ---- active ----
  'active.none': 'No assignments in progress.',
  'active.header': (p: { n: number; lines: string }) => `🛠️ ${p.n} assignment(s) in progress:\n${p.lines}`,
  'active.hint': 'Unassign one with /unassign <applicationId> — the "id" number shown on each row above.',

  // ---- review ----
  'review.none': 'No submissions awaiting review. 🎉',
  'review.count': (p: { n: number }) => `📬 ${p.n} submission(s) awaiting review:`,
  'full.gone': 'Submission not found (it may have been erased).',
  'review.attachFail': '⚠️ Could not load this submission’s attachment from Telegram — it may no longer be available.',

  // ---- close / reopen ----
  'close.usage': 'Usage: /close <taskId>',
  'close.ok': (p: { id: number }) => `🔒 Closed #${p.id}.`,
  'reopen.usage': 'Usage: /reopen <taskId>',
  'reopen.ok': (p: { id: number }) => `📢 Reopened #${p.id}.`,
  'task.closeFail': 'Could not close the task.',
  'task.reopenFail': 'Could not reopen the task.',

  // ---- unassign ----
  'unassign.usage': 'Usage: /unassign <applicationId>',

  // ---- forget ----
  'forget.usage': 'Usage: /forget <contributorId> — their Telegram numeric id (shown as "user N" on applicant and review cards; NOT the "id N" application id).',
  'forget.ok': (p: { id: number }) =>
    `🗑️ Erased contributor ${p.id}: profile, applications, and submissions deleted; history anonymized; notifications to or about them purged.`,
  'forget.fail': 'Could not erase the contributor.',

  // ---- privacy ----
  'privacy.text': (p: { ai: boolean; notifRetentionDays: number }) =>
    [
      '🔐 What this bot stores about you',
      '',
      'When you use the bot: your Telegram id, username, display name, and language; your applications and pitches; the work you submit; and each task’s action history. People who only read or chat in a group with the bot are not recorded.',
      `Delivery records for notifications are kept for ${p.notifRetentionDays} days, then deleted. Data you erase is removed from the live database immediately; copies in infrastructure backups age out automatically as those backups expire under the configured retention window.`,
      ...(p.ai
        ? [
            'When AI assistance is enabled, submitted text and task briefs are processed by NEAR AI Cloud to draft summaries for reviewers.',
            'In groups where this room’s admins turned signal detection ON (announced in the group; /signalstatus shows it), messages are also processed by NEAR AI Cloud to suggest task drafts. The messages themselves and their authors are never stored — only an anonymous score record.',
          ]
        : []),
      '',
      'To have everything about you erased, ask any admin — erasure deletes your profile, applications, and submissions, anonymizes history, and purges notification records about you, queued or already delivered.',
    ].join('\n'),

  // ---- status ----
  'status.usage': 'Usage: /status <taskId>',
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
      `🙋 Applications awaiting decision: ${p.applications}${p.where} → /applicants <taskId>`,
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
  'ai.draftDescriptionResult': (p: { draft: string }) => `Draft description:\n\n${p.draft}`,
  'ai.draftOutputResult': (p: { draft: string }) => `Suggested required output:\n\n${p.draft}`,

  // ---- apply wizard ----
  'apply.notOpen': 'That task is not open for applications.',
  'apply.full': (p: { id: number }) =>
    `Task #${p.id} is fully assigned and not accepting applications right now.`,
  'apply.prompt': (p: { id: number; title: string }) =>
    `Applying to #${p.id} "${p.title}".\nSend a short pitch — why you? (or "-" to apply without one; /cancel to abort)`,
  'apply.pitchText': 'Please send your pitch as text, or "-" to skip.',
  'apply.applied': (p: { id: number }) =>
    `✅ Applied to #${p.id}. An admin will review applicants and assign the task.`,
  'apply.fail': 'Could not apply — please try again.',

  // ---- submit wizard ----
  'sub.notYours': 'That application is not yours.',
  'sub.notAssigned': 'You are not currently assigned to that task.',
  'sub.awaitingReview': 'Your latest submission is still awaiting review.',
  'sub.alreadyApproved': 'This task was already approved. 🎉',
  'sub.prompt': (p: { id: number; title: string }) =>
    `Submit your work for #${p.id}${p.title ? ` "${p.title}"` : ''}.\nSend text, a link, a file, a screenshot, or a video. (/cancel to abort)`,
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
  'rev.notePrompt': 'Add a note for the contributor (or send "-" to skip, /cancel to abort):',
  'rev.noteText': 'Please send a text note, or "-" to skip.',
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
    `🛡 ${p.name} is now a room admin for this group — they can manage this room’s tasks via a DM with the bot. (If they haven’t started the bot yet, they should DM it /help first.)`,
  'rooms.alreadyAdmin': (p: { name: string }) => `${p.name} is already a room admin here.`,
  'rooms.adminRemoved': (p: { name: string }) => `➖ ${p.name} is no longer a room admin for this group.`,
  'rooms.notAdmin': (p: { name: string }) => `${p.name} is not a room admin here.`,
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

  // ---- shared manageability errors (room-aware admin commands) ----
  'task.notManageable': (p: { id: number }) => `Task #${p.id} not found (or not yours to manage).`,
  'app.notManageable': (p: { id: number }) => `Application #${p.id} not found (or not yours to manage).`,

  // ---- notifications ----
  'notify.signalDraft': (p: { line: string; room: string | null }) =>
    `🔎 Signal detection drafted a task from${p.room ? ` "${p.room}"` : ' a group'}:\n${p.line}\n\nReview it with /approve (or leave it as a draft).`,
  'notify.roomRegistered': (p: { title: string | null; chatId: number; inviterId: number | null }) =>
    `👥 The bot was added to the group ${p.title ? `"${p.title}"` : String(p.chatId)}${
      p.inviterId !== null ? ` by user ${p.inviterId}, who is now that room’s first admin` : ''
    }.\nA room admin can enable AI task drafts there with /enablesignals, and add more room admins with /addroomadmin (as a reply to their message).`,
  'notify.roomAdminPromoted': (p: { title: string | null }) =>
    `🛡 You’re now a room admin${p.title ? ` for "${p.title}"` : ''}. You can approve, assign, and review that room’s tasks — send /help to see your commands.`,
  'notify.reviewHeader': (p: { card: string }) => `📬 New submission for review\n\n${p.card}`,
  'notify.reviewAiNote': (p: { taskId: number; version: number; note: string }) =>
    `🤖 AI note on submission v${p.version} for task #${p.taskId}:\n${p.note}`,
  'notify.reviewApproved': (p: TaskRef & { reward: string | null; note: string | null }) =>
    `✅ Your submission for ${yourTask(p)} was approved!${p.reward ? ` Reward: ${p.reward}.` : ''}${noteLine(p.note)}`,
  'notify.reviewRejected': (p: TaskRef & { note: string | null }) =>
    `❌ Your submission for ${yourTask(p)} was rejected and this assignment is closed.${noteLine(p.note)}\n\nBrowse /open for other tasks.`,
  'notify.reviewRevise': (p: TaskRef & { note: string | null }) =>
    `🔁 Your submission for ${yourTask(p)} needs revision.${noteLine(p.note)}\n\nUse /myapps to submit a new version.`,
  'notify.assigned': (p: TaskRef) =>
    `🎉 You've been assigned to ${aTask(p)}! Use /myapps to submit your work.`,
  'notify.declined': (p: TaskRef) =>
    `🚫 Your application for ${aTask(p)} wasn't selected this time. Thanks for applying — see /open for more.`,
  'notify.unassigned': (p: TaskRef & { reason: string }) =>
    `➖ You were unassigned from ${aTask(p)}${p.reason ? ` — ${p.reason}` : ''}. Your application is back in the pool.`,
  'notify.announceChat': (p: { line: string }) =>
    `📢 New task open for applications:\n${p.line}\n\nDM the bot and send /open to apply.`,
  'notify.announceDm': (p: { line: string }) =>
    `🆕 A new task may interest you:\n${p.line}\n\nUse /open to view and apply. (/notify off to stop these)`,
  'notify.newApplication': (p: { header: string; card: string }) => `${p.header}\n\n${p.card}`,
  'notify.applicationHeaderTask': (p: { line: string }) => `🙋 New application for ${p.line}`,
  'notify.applicationHeaderId': (p: { id: number }) => `🙋 New application for task #${p.id}`,
  'notify.submissionCaption': (p: { version: number; caption: string }) =>
    `Submission v${p.version}${p.caption ? ` — ${p.caption}` : ''}`,

  // NOTE: the card field-labels in src/bot/format.ts intentionally do NOT route
  // through this catalog yet (see README "Internationalization") — add their
  // keys here only together with the formatter change that consumes them.
} as const;
