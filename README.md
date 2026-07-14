# MultiAgency Bot

A Telegram bot that coordinates public, paid contributor work through a
human-in-the-loop **apply → admin assigns → submit → review** workflow.

Contributors *apply* to open tasks with a short pitch; admins review applicants
and *assign* the task (up to its `max_assignees`); assigned contributors *submit*
work (versioned — each revision is a new version); reviewers approve, reject, or
request revision. AI assists — drafting, summaries, group signal detection, and
an opt-in conversational agent — but humans make every final decision. An
optional read-mostly **Telegram Mini App** mirrors the open-task board, a
contributor's work, and their payouts; approved rewarded work lands in a payout
ledger settled through a NEAR claim escrow.

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
runs typecheck (bot and web), build, and the demo/smoke suites end-to-end against the
real bot stack (middleware, scenes, buttons) with the network stubbed and a **scratch
schema reset per run**. The demos run against a **separate `multiagency_test` database**
(created by docker-compose, sourced via `TEST_DATABASE_URL`), so the reset can never wipe
the dev data in `multiagency` — even if you have `DATABASE_URL` exported.
`npm run edge-demo` drives the adversarial edges the happy
path skips — Telegram size limits (its stub rejects oversized messages like the live
API), group-vs-private privacy surfaces, photo albums, the /forget mid-delivery race,
and the migration version check. `npm run rooms-demo` covers rooms and signal detection
(AI endpoint stubbed): the group bootstrap, the signal pipeline and its privacy
invariants, and room-admin-scoped task management. `npm run agent-tools-demo` covers
the conversational agent's tool guards (visibility, apply mirroring, draft gating);
`npm run web-smoke` drives the Mini App server — initData auth, the read-only oRPC
API, payouts, and the NEAR wallet link — over the same test database.

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
| `AGENT_MODEL`      | –        | Model for the conversational agent (group `/ai` mode) — needs reliable tool calling, so it defaults to `anthropic/claude-haiku-4-5` on the same endpoint |
| `SIGNAL_SCORE_THRESHOLD` | –  | Minimum AI score (0–10) a group message must reach to auto-draft a task (default `6`) |
| `SIGNAL_MAX_PER_HOUR` | –     | Max AI evaluations per room per hour — bounds the AI bill of a flooded group (default `20`) |
| `WEB_PORT` / `PORT` | –       | Port for the in-process Mini App web server (Railway injects `PORT`). Unset leaves the web tier off — the plain bot deployment is unchanged |
| `WEB_APP_URL`      | –        | Public HTTPS origin the Mini App is served from; wires the Telegram chat-menu / home-menu board buttons. Empty leaves them off |
| `NEAR_NETWORK`     | –        | NEAR network the claim escrow lives on (default `testnet`)                                                                       |
| `ESCROW_CONTRACT_ID` | –      | The claim-escrow contract account (see `contracts/escrow`). Empty keeps the claim UI dormant                                     |
| `NEAR_TREASURY_ID` | –        | Treasury account that signs `allocate` — the bot never holds its key; `/payouts` prints the command for a treasury admin to run |

## Commands

**Contributors**

- `/start` — home menu: board (Mini App, when configured), browse, my work,
  settings, help
- `/open` — browse open tasks one card at a time (◀ ▶ to flip), tap **Apply**
  and send a short pitch; **Share** drops the card into any other chat via
  inline mode (fully-assigned tasks stay visible but take no applications)
- `@<bot> <query>` in any chat — inline mode: search open tasks and share one as
  a card with an Apply deep link
- `/myapps` — your applications + states; tap **Submit** on assigned ones
- `/submit <applicationId>` — submit work (text, link, file, screenshot, or video; captions kept)
- `/withdraw <applicationId>` — withdraw an application
- `/notify on` / `/notify off` (or the `/settings` toggle) — opt in/out of a DM
  when a new task opens (off by default; the announce channel is the primary broadcast)
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
- `/payouts` — the funding queue: payouts owed for approved rewarded work, each
  with the contributor's linked wallet state and (when linked) the exact
  treasury `allocate` command; reconciles stored status against the chain
- `/forget <contributorId>` — erase a contributor's data (profile, applications,
  submissions, payout ledger rows; history details scrubbed; task authorship
  cleared; notification rows to or about them purged). Refused while a funded
  (`claimable`) escrow payout awaits claim — erasing its ledger row would
  strand NEAR already deposited on-chain

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
- `/ai on|off|status` — conversational AI mode for this group (same gating and
  the same public notice; status answers any member)
- `/settings` — one tap-toggle panel folding the two room toggles (the panel is
  public; authorization is enforced on the tap)
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
tasks). A short **context window** of the room's recent chatter accompanies each
evaluation (so a draft can pick up a deadline mentioned a few lines earlier) —
it is RAM-only, bounded (15 messages / 30 minutes), never persisted, and
recorded **only for rooms that opted in**; chatter from rooms that never ran
`/enablesignals` never enters it. Group members who never DM the bot are never
recorded, same as always.

**Telegram requirement:** under default privacy mode the bot only receives
commands in groups, so signal detection (and addressing the agent by @mention)
needs one of: **promote the bot to admin in that specific group** (recommended —
scoping stays per-group), or turn privacy mode off globally via @BotFather
(`/setprivacy`, then re-add the bot to the group). All other features work fine
without either.

## AI mode (opt-in, per group)

Where a room admin ran `/ai on`, members talk to the bot in natural language by
**addressing it** — an @mention or a reply to one of its messages. It answers
via a tool-calling loop (browse tasks, look one up, list your applications) and
*proposes* actions as confirmation cards: a task draft shows the admin the same
**Approve** button `/approve` uses; an apply suggestion shows the same **Apply**
button — a human still taps, through the identical auth and workflow guards, so
the agent can never create, open, or apply on its own. It runs on a stronger
tool-calling model (`AGENT_MODEL`) than signal scoring, on the same NEAR AI
endpoint. Conversation memory is RAM-only, bounded, and expires after minutes;
ambient (unaddressed) chatter is untouched unless signal detection is also on —
the two features compose per room.

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
- Converse in groups with AI mode on — proposing drafts and applications as
  confirmation cards a human still taps (see "AI mode" above)

AI never approves contributors or submissions, and never opens a task.

## Mini App & payouts (NEAR)

An optional **Telegram Mini App** (React, served by an in-process Hono server
behind `WEB_PORT`/`PORT`) mirrors the bot **read-mostly**: the open-task board,
task detail, your applications, and your payouts. Every mutation (apply, submit,
review) stays in the bot — the app deep-links back into it. The oRPC API is
gated by Telegram **initData** verification (identity, not entitlement: drafts
are never served), runs on the same Postgres pool and `src/core/` service layer,
and is caller-scoped — you can only read your own work. `web-smoke` covers the
whole tier.

Approving rewarded work records a row in the **payout ledger** (same transaction
as the approval). Settlement is contributor-pull through a NEAR **claim escrow**
(`contracts/escrow`): the treasury allocates + funds a payout on-chain (the
`/payouts` admin command prints the exact `near` CLI command — the bot never
holds a key), and the contributor claims it from their own wallet. Contributors
link a wallet in the Mini App via a NEP-413 signed challenge, and claim funded
payouts from the Payouts screen with that wallet (near-connect; `claimable` is
read live from the chain per payout).

**Privacy note:** funding and claiming write the linked NEAR account and the
task id to the public NEAR blockchain — permanently. Nothing on-chain names the
Telegram identity, and `/forget` erases the stored wallet link between the two,
but the on-chain record is beyond erasure; `/privacy` discloses this, and the
wallet-link UI must surface it at the moment of linking.

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

The bot uses long polling, so on its own it deploys as a plain worker — no
public port, domain, or webhook needed. The optional Mini App is the exception:
it serves HTTP from the same process, so enabling it means exposing the service
(Railway injects `PORT`; attach a domain and set `WEB_APP_URL` to it).
`railway.json` configures the build and restart policy.

1. Add the **Railway PostgreSQL** plugin to the project — it injects `DATABASE_URL`
   into the service automatically.
2. Set the service variables: `BOT_TOKEN`, `ADMIN_IDS`, and optionally the NEAR AI /
   announcement / Mini App / escrow variables. (`DATABASE_URL` comes from the plugin.)
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
environments. Profiles are only created by a user-initiated act — DMing the bot
or linking a wallet in the Mini App; group members are never recorded passively.
`/privacy` states the retention rules to users, and `/forget` handles deletion
requests (deleting active rows immediately; managed backups age out per the
configured retention; funded-but-unclaimed payouts sequence erasure behind a
claim or revoke).

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
  core/                framework-free service layer (shared by the bot and the web tier)
    db.ts              Postgres pool, AsyncLocalStorage tx runner, file migration runner
  ../db/migrations/    forward-only *.sql schema migrations
    workflow.ts        three state machines (task, application, submission)
    service.ts         orchestration: approve/apply/assign/submit/review/erase, rooms,
                       signals, payouts; shared reads + the task-visibility floor
    models/            task, application, submission, contributor, history, notification,
                       room, signal, payout, walletLink
  ai/
    assist.ts          optional NEAR AI Cloud helpers (degrade gracefully)
    agent.ts           conversational agent loop (RAM-only convo memory)
    agentTools.ts      the agent's tools — read + propose-via-card only
    client.ts          shared OpenAI-compatible client
  bot/                 Telegraf layer (commands, scenes, keyboards, i18n)
    notify.ts          notification producers (render + enqueue, never send inline)
    worker.ts          single global queue worker (paced delivery, retry, backoff)
    signals.ts         signal-detection pipeline (prefilter → opt-in → context → AI → Draft)
    roomContext.ts     RAM-only per-room context window (consent-gated)
  web/                 Mini App tier: Hono server, oRPC read API, initData auth,
                       NEP-413 wallet link
  near/escrow.ts       claim-escrow reads + the treasury allocate command
  index.ts             entry point (long polling; starts the worker + web server)
web/                   Mini App frontend (React + Vite)
contracts/escrow/      NEAR claim-escrow contract (Rust; see its README)
```

The `core/` layer has **zero Telegram coupling** — the web tier (`src/web/`)
calls the same service functions the bot does.

## Not in this MVP (deferred)

Admin web dashboard (the Mini App is contributor-facing and read-mostly),
multi-channel support, automated
candidate scoring, task↔candidate matching, auto-assignment, deadline
automation (reminders/expiry), reward-amount automation (rewards are free text,
e.g. `100 USDC`; on-chain amounts are set by the treasury at escrow funding),
agent memory beyond the in-RAM window, and advanced reputation/anti-fraud.
