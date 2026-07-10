# MultiAgency Bot

A Telegram bot that coordinates public, paid contributor work through a
human-in-the-loop **apply → admin assigns → submit → review** workflow.

Contributors *apply* to open tasks with a short pitch; admins review applicants
and *assign* the task (up to its `max_assignees`); assigned contributors *submit*
work (versioned — each revision is a new version); reviewers approve, reject, or
request revision. AI assists with drafting and summaries; humans make every
final decision.

See [SCOPE.md](SCOPE.md) for boundaries and [DEMO.md](DEMO.md) for the pilot script.

## Workflow (three entities)

```
Task:        Draft ──approve──▶ Open ──close──▶ Closed ──reopen──▶ Open

Application:  Applied ──assign──▶ Assigned        (admin, up to max_assignees)
                 │  ──decline──▶ Declined          (not selected; may re-apply)
                 │  ──withdraw─▶ Withdrawn
              Assigned ──unassign──▶ Applied       (admin, records a reason)
              Assigned ──work approved──▶ Completed (terminal; slot stays consumed)
              Assigned ──work rejected──▶ Rejected (terminal; slot freed)

Submission:  Submitted ──approve──▶ Approved       (each revision = a new version)
                       ──reject───▶ Rejected       (terminal — also closes the assignment)
                       ──revise───▶ Needs revision  → contributor submits a new version
```

Closing a task stops **new applications** but assigned contributors can still
submit and reviewers can still complete existing work. A review decision closes
its assignment atomically — approve moves the application to **Completed**
(terminal; the slot stays consumed), reject moves it to **Rejected** (terminal:
no re-apply, no re-assign; the slot frees for someone else); request a
**revision** instead when you want another version. Every step is recorded in
`task_history` per task.

## Setup

Requires Node.js 22+ (Node 24 recommended; pinned in `.nvmrc`). Because
`better-sqlite3` is a native module, use one Node version consistently across
dev, CI, and deploy — mixing majors causes an ABI-mismatch error at startup
(`npm rebuild better-sqlite3` fixes it locally after a version switch).

```bash
npm install
cp .env.example .env   # then fill in the values (see below)
npm run dev            # watch mode, or:  npm run build && npm start
```

To check the whole loop without touching Telegram, `npm run demo` runs the
[DEMO.md](DEMO.md) script end-to-end against the real bot stack (middleware,
scenes, buttons) with the network stubbed and a throwaway database.
`npm run edge-demo` drives the adversarial edges the happy path skips —
Telegram size limits (its stub rejects oversized messages like the live API),
group-vs-private privacy surfaces, photo albums, the /forget mid-delivery
race, and backup restorability.

### Environment (`.env`)

| Variable           | Required | Purpose                                                                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`        | ✅       | Bot token from [@BotFather](https://t.me/BotFather)                                                                             |
| `ADMIN_IDS`        | ✅       | Comma-separated Telegram numeric IDs allowed to create/approve/review. Get yours from [@userinfobot](https://t.me/userinfobot). |
| `DATABASE_PATH`    | –        | SQLite file path (default `./data/multiagency.sqlite`)                                                                          |
| `ANNOUNCE_CHAT_ID` | –      | Chat where newly opened tasks are announced — the primary discovery surface. Any chat: a private/public group or a channel (numeric id or `@username`); the bot must be a member (admin to post in a channel). Empty disables (approval unaffected). |
| `BOT_USERNAME`     | –        | Bot @username (no `@`). When set, the announcement post carries a deep-link **Apply** button (`t.me/<username>?start=t<taskId>`); otherwise it points at `/open`. |
| `NOTIFY_RATE_PER_SEC` | –     | Global cap on outbound notifications/sec, applied across the whole queue by the delivery worker (default `25`; Telegram's bulk limit is ~30/s) |
| `MAX_OPEN_APPLICATIONS` | –   | Max pending (undecided) applications one contributor may hold (default `5`)                                                     |
| `NEAR_AI_API_KEY`  | –        | [NEAR AI Cloud](https://cloud.near.ai) key. Enables AI assistance; omit to run without AI (fully functional). |
| `NEAR_AI_BASE_URL` | –        | OpenAI-compatible endpoint (default `https://cloud-api.near.ai/v1`)                                                             |
| `AI_MODEL`         | –        | AI model (default `deepseek-ai/DeepSeek-V4-Flash`, a private-TEE chat model; see [`/v1/models`](https://cloud-api.near.ai/v1/models)) |

## Commands

**Contributors**

- `/open` — browse open tasks, tap **Apply** and send a short pitch (fully-assigned
  tasks stay visible but take no applications)
- `/myapps` — your applications + states; tap **Submit** on assigned ones
- `/submit <applicationId>` — submit work (text, link, file, screenshot, or video; captions kept)
- `/withdraw <applicationId>` — withdraw an application
- `/notify on` / `/notify off` — opt in/out of a DM when a new task opens (off by
  default; the announce channel is the primary broadcast)
- `/status <taskId>` — a task's public status and history (personal history events
  appear only in a DM; groups see task-level events only)
- `/privacy` — what the bot stores, retention, the AI data flow, and how erasure works

**Admins** (must be in `ADMIN_IDS`)

- `/admin` — overview: counts of drafts, open tasks, pending applications, active
  assignments, submissions to review, and notification-queue health (pending /
  failed), each pointing at the command that acts
- `/newtask` — task-creation wizard (sets `max_assignees`; `/ai` drafts description/output)
- `/approve` — approve draft tasks (Draft → Open), announced to the channel if configured
- `/applicants <taskId>` — each applicant's pitch + track record; **Assign** / **Decline**
- `/active` — assignments in progress (assignee, submission state, age)
- `/review` — review submitted work (Approve / Reject / Revise, with a note); attachments
  re-sent, and a **📄 Full submission** button on any card that had to clip long content
- `/close <taskId>` / `/reopen <taskId>` — stop / resume accepting applications
- `/unassign <applicationId>` — remove an assignment (records a reason, notifies the contributor)
- `/forget <contributorId>` — erase a contributor's data (profile, applications,
  submissions; history details scrubbed; task authorship cleared; notification
  rows to or about them purged)

`/cancel` aborts any multi-step wizard.

## Notifications

Every bot-initiated push (announcements, alerts, outcome DMs) is **enqueued**, not
sent inline: command handlers return immediately, and a **single background worker**
drains the `notifications` queue. This gives one **global** Telegram rate limiter
(one paced sender, never exceeding `NOTIFY_RATE_PER_SEC` across all broadcasts),
**retry with exponential backoff**, **429 flood-control** handling, and **restart
safety** — delivery status is persisted, so a restart resumes where it left off.
Delivery is at-least-once: a crash between a successful send and the status write
can duplicate that one message on restart; nothing is lost to a restart. `/admin`
surfaces queue health (pending / failed). Command *replies* to the acting user
stay synchronous; only pushes queue.

All notifications point back at the bot's commands — `/open` and `/myapps` are the
source of truth; a missed notification never loses state.

- **New task opened**: an announcement to the channel (if configured) — the primary,
  O(1) discovery post, carrying a deep-link **Apply** button when `BOT_USERNAME` is
  set — plus opt-in DMs to contributors who ran `/notify on`. Approval returns
  immediately regardless of audience size.
- **New application**: every admin gets the applicant's pitch + track record with
  one-tap **Assign** / **Decline** buttons.
- **Application outcome**: the contributor is DM'd when assigned, declined, or
  unassigned (with the reason).
- **New submission**: reviewers get the work, its version, the contributor's track
  record, the original attachment, and (if enabled) an AI summary.
- **Review outcome**: the contributor is DM'd on approve / reject / revise.

## AI assistance (optional, human stays in control)

Powered by [NEAR AI Cloud](https://cloud.near.ai) via its OpenAI-compatible API.
When `NEAR_AI_API_KEY` is set:

- Draft a task description from a short prompt (`/ai` in `/newtask`)
- Suggest a required-output spec (`/ai` in `/newtask`)
- Summarize a submission (text, link, or file caption) for the reviewer, noting any
  required-output items that appear missing — observations only, never a verdict

AI never approves contributors or submissions.

## Internationalization

Launch is **English-only**, but the framework is in place. All user-facing chrome
resolves through `t(locale, key, params)` in `src/bot/i18n.ts` against the English
catalog in `src/bot/locales/en.ts` — the single source of truth. The locale comes
from Telegram's `language_code` (stored per contributor for notifications), with
English fallback for any unknown locale or key.

- **What routes through `t()`:** every command reply, callback popup, wizard
  prompt, inline-keyboard button label, and notification (`index.ts`,
  `context.ts`, all scenes, `keyboards.ts`, `notify.ts`).
  Interpolated values (task titles, pitches, ids) are passed as params and never
  translated.
- **Not yet localized (intentional seam):** the card field-labels in `format.ts`
  and the status words in `core/workflow.ts` render English literals. They're
  embedded in cards shown to different viewers, so localizing them cleanly needs a
  viewer-locale argument threaded through the formatters — a deliberate follow-up,
  not needed for an English launch.
- **To add a language:** copy `locales/en.ts` to `locales/<code>.ts`, translate the
  values (keys unchanged), and register it in `i18n.ts`. No call-site changes.
  Reviewed catalogs come once we see which languages contributors actually need.

## Deployment (Railway)

The bot uses long polling, so it deploys as a plain worker — no public port,
domain, or webhook needed. `railway.json` configures the build and restart
policy.

1. Attach a **volume** mounted at `/data` — SQLite must live on it or the
   database is wiped on every deploy.
2. Set the service variables: `DATABASE_PATH=/data/multiagency.sqlite`,
   `BOT_TOKEN`, `ADMIN_IDS`, and optionally the NEAR AI variables.
3. Deploy with `railway up` (or connect the GitHub repo for deploys on push).

Only one process may poll a given bot token: `railway.json` pins
`numReplicas: 1` — don't raise it (polling and the global rate limiter both
assume one process) — and stop any local `npm run dev` against the same token
before deploying.

### Deploy-day checklist

Dashboard/manual steps no config file can do:

1. **Railway volume backups** — service → volume → enable scheduled backups.
   The in-app daily snapshot covers corruption; only this covers losing the
   volume itself.
2. **Group privacy mode** — must stay at BotFather's default (ON): the
   group-gating logic assumes commands-only delivery in groups. Verify with
   `curl -s "https://api.telegram.org/bot$BOT_TOKEN/getMe"` —
   `can_read_all_group_messages` must be `false`. (BotFather → /mybots →
   Bot Settings → Group Privacy, if it was ever turned off.)
3. **Failure signals** — backup failures DM all admins automatically and
   `/admin` shows failed-notification counts; the log lines
   `database backup FAILED` and `gave up on notification` are for forensics,
   not monitoring.
4. Stop any local `npm run dev` on the production token before the first
   deploy (two pollers fight over updates).

**Data protection.** The SQLite volume stores personal data — contributor
Telegram usernames, display names, and user IDs. Restrict access to the Railway
project and volume, and don't copy the database to untrusted environments.
Profiles are only created for people who DM the bot (group members are never
recorded), `/privacy` states the retention rules to users, and `/forget`
handles deletion requests.

**Backups.** The worker snapshots the database daily (better-sqlite3's online
backup, safe under WAL) to `<DATABASE_PATH>.backup-<weekday>` on the same
volume — a 7-file rotation, so erased contributors also age out of backups
within a week. This covers corruption and botched migrations; for loss of the
volume itself, enable Railway's volume backups in the dashboard. A failed
backup DMs every admin (once per day, via the notification queue) and logs
`database backup FAILED`.

**Schema migrations.** The schema is a sequential migration list in
`src/core/db.ts`, tracked via SQLite's `user_version` pragma. To change the
schema, append a new SQL string to `MIGRATIONS` — never edit an applied entry
(deployed databases have already run it). Each pending migration applies once,
transactionally, at startup.

## Project structure

```
src/
  config.ts            env + admin checks
  core/                framework-free service layer (reusable by a future API)
    db.ts              SQLite connection + schema
    workflow.ts        three state machines (task, application, submission)
    service.ts         orchestration: approve/apply/assign/submit/review/erase
    models/            task, application, submission, contributor, history, notification
  ai/assist.ts         optional NEAR AI Cloud helpers (degrade gracefully)
  bot/                 Telegraf layer (commands, scenes, keyboards, i18n)
    notify.ts          notification producers (render + enqueue, never send inline)
    worker.ts          single global queue worker (paced delivery, retry, backoff)
  index.ts             entry point (long polling; starts the notification worker)
```

The `core/` layer has **zero Telegram coupling** — a web/API layer (e.g. Hono + oRPC +
better-auth) can call the same service functions later with no rework.

## Not in this MVP (deferred)

Web dashboard, multi-channel support, automated candidate scoring, task↔candidate
matching, auto-assignment, deadline automation (reminders/expiry), reward
automation / on-chain payouts, agent memory, and advanced reputation/anti-fraud.
Rewards are recorded as free text (e.g. `100 USDC`).
