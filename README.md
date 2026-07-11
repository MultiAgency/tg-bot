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

Requires Node.js 22+ (Node 24 recommended; pinned in `.nvmrc`) and **PostgreSQL**.
For local dev a `docker-compose.yml` starts one:

```bash
npm install
docker compose up -d                # Postgres on localhost:5455
cp .env.example .env                 # DATABASE_URL points at that Postgres; fill in BOT_TOKEN + ADMIN_IDS
npm run db:init                      # apply migrations (or db:reset for a clean slate)
npm run dev                          # watch mode, or:  npm run build && npm start
```

`initSchema()` also runs the migrations automatically on every boot, so `npm start`
is self-bootstrapping. To check the whole loop without touching Telegram, `npm test`
runs typecheck, build, and the five demo suites end-to-end against the real bot stack
(middleware, scenes, buttons) with the network stubbed and a **scratch schema reset per
run**. The demos run against a **separate `multiagency_test` database** (created by
docker-compose, sourced via `TEST_DATABASE_URL`), so the reset can never wipe the dev
data in `multiagency` — even if you have `DATABASE_URL` exported. `npm run edge-demo` drives the adversarial edges the happy
path skips — Telegram size limits (its stub rejects oversized messages like the live
API), group-vs-private privacy surfaces, photo albums, the /forget mid-delivery race,
and the migration version check. `npm run rooms-demo` covers rooms and signal detection
(AI endpoint stubbed): the group bootstrap, the signal pipeline and its privacy
invariants, and room-admin-scoped task management.

### Environment (`.env`)

| Variable           | Required | Purpose                                                                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`        | ✅       | Bot token from [@BotFather](https://t.me/BotFather)                                                                             |
| `ADMIN_IDS`        | ⚠️       | Comma-separated Telegram numeric IDs allowed to create/approve/review. The bot boots without it (logs a warning), but no one can create, approve, or review until it's set. Get yours from [@userinfobot](https://t.me/userinfobot). |
| `DATABASE_URL`     | ✅       | PostgreSQL connection string (Railway injects it from its Postgres plugin; local dev uses the docker-compose Postgres)          |
| `ANNOUNCE_CHAT_ID` | –      | Chat where newly opened tasks are announced — the primary discovery surface. Any chat: a private/public group or a channel (numeric id or `@username`); the bot must be a member (admin to post in a channel). Empty disables (approval unaffected). |
| `BOT_USERNAME`     | –        | Bot @username (no `@`). When set, the announcement post carries a deep-link **Apply** button (`t.me/<username>?start=t<taskId>`); otherwise it points at `/open`. |
| `NOTIFY_RATE_PER_SEC` | –     | Global cap on outbound notifications/sec, applied across the whole queue by the delivery worker (default `25`; Telegram's bulk limit is ~30/s) |
| `MAX_OPEN_APPLICATIONS` | –   | Max pending (undecided) applications one contributor may hold (default `5`)                                                     |
| `NEAR_AI_API_KEY`  | –        | [NEAR AI Cloud](https://cloud.near.ai) key. Enables AI assistance; omit to run without AI (fully functional). |
| `NEAR_AI_BASE_URL` | –        | OpenAI-compatible endpoint (default `https://cloud-api.near.ai/v1`)                                                             |
| `AI_MODEL`         | –        | AI model (default `deepseek-ai/DeepSeek-V4-Flash`, a private-TEE chat model; see [`/v1/models`](https://cloud-api.near.ai/v1/models)) |
| `SIGNAL_SCORE_THRESHOLD` | –  | Minimum AI score (0–10) a group message must reach to auto-draft a task (default `6`) |
| `SIGNAL_MAX_PER_HOUR` | –     | Max AI evaluations per room per hour — bounds the AI bill of a flooded group (default `20`) |

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

**Room admins** (per-group, no `ADMIN_IDS` entry needed)

Every group the bot is added to becomes a **room**; whoever added the bot is its
first room admin, and more are added with `/addroomadmin` (below). Room admins
get the task-management commands — `/approve`, `/applicants`, `/active`,
`/review`, `/close`, `/reopen`, `/unassign` — scoped to **their rooms' tasks**
(tasks auto-drafted from that group's signals). They run them in a DM like any
admin, and receive the same application/submission notifications for those
tasks. Creating tasks (`/newtask`), the global overview (`/admin`), and erasure
(`/forget`) stay global-admin-only. A task created via DM belongs to no room and
is manageable only by global admins.

**In a group** (the room-local commands)

- `/enablesignals` / `/disablesignals` — turn AI signal detection on/off for
  this group (room admins or global admins; needs AI enabled). Turning it on
  posts a public notice in the group — that's the members' disclosure.
- `/signalstatus` — is this group being scanned? (answers any member)
- `/addroomadmin` / `/removeroomadmin` — **reply to a message** from the person,
  then send the command (bots can't resolve @username → id); the person is
  DM'd (best-effort — they may need to Start the bot first)
- `/roomadmins` — list this group's room admins

## Signal detection (opt-in, per group)

In a group where a room admin ran `/enablesignals`, the bot scores messages
with AI and turns promising ones (an event, a request, a community ask) into
**Draft** tasks linked to that room — a human still `/approve`s every one; AI
never opens a task. The pipeline per message: cheap prefilter (length/words) →
per-room hourly budget (`SIGNAL_MAX_PER_HOUR`, enforced against stored rows so
it survives restarts and concurrent messages) → AI score → draft when the score
clears `SIGNAL_SCORE_THRESHOLD` *and* the model itself says to draft. Room
admins and global admins are notified of every auto-draft.

**Privacy invariants** (see `/privacy`): the message text goes to the model and
is then dropped — a signal row stores only room, score, and outcome; the
author's identity is stored nowhere (`created_by` stays null on signal-drafted
tasks). Group members who never DM the bot are never recorded, same as always.

**Telegram requirement:** under default privacy mode the bot only receives
commands in groups, so signal detection needs one of: **promote the bot to
admin in that specific group** (recommended — scoping stays per-group), or turn
privacy mode off globally via @BotFather (`/setprivacy`, then re-add the bot to
the group). All other features work fine without either.

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
- Score group messages into Draft tasks where signal detection is enabled
  (see "Signal detection" above)

AI never approves contributors or submissions, and never opens a task.

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

1. Add the **Railway PostgreSQL** plugin to the project — it injects `DATABASE_URL`
   into the service automatically.
2. Set the service variables: `BOT_TOKEN`, `ADMIN_IDS`, and optionally the NEAR AI /
   announcement variables. (`DATABASE_URL` comes from the plugin.)
3. Deploy with `railway up` (or connect the GitHub repo for deploys on push).
   `initSchema()` applies any pending migrations on boot — no manual step.

Only one process may poll a given bot token: `railway.json` pins
`numReplicas: 1` — don't raise it (polling and the global rate limiter both
assume one process) — and stop any local `npm run dev` against the same token
before deploying.

### Deploy-day checklist

> **Clean start — no data is carried over from any earlier deployment.**
> `initSchema()` only creates the schema; it never imports existing rows, so the
> bot starts with zero contributors, tasks, applications, submissions, history, and
> queued notifications. This is a deliberate fresh start, not an oversight.
> Consequences to accept before deploying: contributors mid-task must re-`/start`
> and re-apply; any announcement deep-links issued by an earlier deployment
> (`t.me/<bot>?start=t<id>`) no longer resolve to the same task (ids restart at 1);
> notifications queued but unsent under an earlier deployment are dropped. Carrying
> data across would require a separately built and tested import — do not expect
> boot to do it.

Dashboard/manual steps no config file can do:

1. **Postgres backups / PITR** — the Railway Postgres plugin provides managed
   backups and point-in-time recovery; configure the retention window in the
   plugin's settings. Backups are infrastructure's responsibility (the app does
   not snapshot the database itself). Run one **restore drill** into a scratch
   database before launch, and confirm the configured retention matches what
   `/privacy` promises. Restoring resurrects any PII erased since the backup was
   taken; because `/forget` events carry no subject id, the database can't tell
   you who to re-erase, so if a restore ever happens keep an out-of-band record of
   erasure requests to replay `/forget` against the restored data.
2. **Group privacy mode** — keep BotFather's default (ON) unless you use
   signal detection. With it ON the bot receives only commands in groups; the
   group-gating logic is safe either way, but non-command messages are pure
   noise unless a room opted into signals. To scan a specific group, prefer
   **promoting the bot to admin in that group** over flipping global privacy
   mode (admin bots receive everything regardless of the setting). Verify the
   global setting with `curl -s "https://api.telegram.org/bot$BOT_TOKEN/getMe"`
   → `can_read_all_group_messages`. (BotFather → /mybots → Bot Settings →
   Group Privacy; re-add the bot to the group after changing it.)
3. **Failure signals** — `/admin` shows failed-notification counts; the log line
   `gave up on notification` is for forensics, not monitoring.
4. Stop any local `npm run dev` on the production token before the first
   deploy (two pollers fight over updates).

**Data protection.** The Postgres database stores personal data — contributor
Telegram usernames, display names, and user IDs. Restrict access to the Railway
project and its Postgres plugin, and don't copy the database to untrusted
environments. Profiles are only created for people who DM the bot (group members
are never recorded), `/privacy` states the retention rules to users, and `/forget`
handles deletion requests (deleting active rows immediately; managed backups age
out per the configured retention).

**Schema migrations.** The schema is a set of sequential, forward-only SQL files
in `db/migrations/` (`001_initial.sql`, `002_rooms.sql`, …), applied once each at
startup by `initSchema()` and tracked in a `schema_migrations` table (with a
checksum guard). To change the schema, add a new higher-numbered file — **never
edit an applied one** (see `db/migrations/README.md`). `npm run db:init` applies
pending migrations; `npm run db:reset` (test only) rebuilds from scratch.

## Project structure

```
src/
  config.ts            env + admin checks
  core/                framework-free service layer (reusable by a future API)
    db.ts              Postgres pool, AsyncLocalStorage tx runner, file migration runner
  ../db/migrations/    forward-only *.sql schema migrations
    workflow.ts        three state machines (task, application, submission)
    service.ts         orchestration: approve/apply/assign/submit/review/erase, rooms & signals
    models/            task, application, submission, contributor, history, notification, room, signal
  ai/assist.ts         optional NEAR AI Cloud helpers (degrade gracefully)
  bot/                 Telegraf layer (commands, scenes, keyboards, i18n)
    notify.ts          notification producers (render + enqueue, never send inline)
    worker.ts          single global queue worker (paced delivery, retry, backoff)
    signals.ts         signal-detection pipeline (prefilter → budget → AI → Draft)
  index.ts             entry point (long polling; starts the notification worker)
```

The `core/` layer has **zero Telegram coupling** — a web/API layer (e.g. Hono + oRPC +
better-auth) can call the same service functions later with no rework.

## Not in this MVP (deferred)

Web dashboard, multi-channel support, automated candidate scoring, task↔candidate
matching, auto-assignment, deadline automation (reminders/expiry), reward
automation / on-chain payouts, agent memory, and advanced reputation/anti-fraud.
Rewards are recorded as free text (e.g. `100 USDC`).
