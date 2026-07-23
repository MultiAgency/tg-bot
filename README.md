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
ledger settled by push through a Sputnik DAO (see [PAYOUTS.md](PAYOUTS.md)).

**What this is (and isn't).** This is **one operator's bounty board, open to
public contributors** — one bot instance, one global admin list, one treasury,
with any number of Telegram groups attached as scoped rooms. It is *not* a
self-serve platform for arbitrary communities: a group that adds the bot gets
a room on this instance (its own admins, its own signal-drafted tasks), not
its own marketplace — every payout still flows from the operator's DAO and
every `/pay` is run by the operator's global admins. Per-community treasuries
and tenant isolation are a different product (see "Not in this MVP").

**Scope model — one agency, many rooms.** Global tasks (created by the
operator's global admins via `/newtask`) are the public board: announced to the
channel and the `/notify on` DMs, searchable inline, listed in the Mini App. A
**room task** (drafted from a group's chat signals or its AI mode, approved by
that room's admins) belongs to its group: it announces only there and appears
only on that group's `/open` (alongside the global board) — the bot never
amplifies a room's tasks beyond the room, so a self-registered group can only
ever address itself. Id-based lookups (`/status`, deep links, Mini App detail)
stay public records, so deliberately shared links keep working. All payouts
flow from the single operator treasury (see [PAYOUTS.md](PAYOUTS.md)).

See [SCOPE.md](SCOPE.md) for boundaries and [DEMO.md](DEMO.md) for the pilot script.

## Workflow (three entities)

```
Task:        Draft ──approve──▶ Open ──close──▶ Closed ──reopen──▶ Open

Application:  Applied ──assign──▶ Assigned        (admin, up to max_assignees)
                 │  ──decline──▶ Declined          (not selected; may re-apply)
                 │  ──withdraw─▶ Withdrawn
              Assigned ──withdraw──▶ Withdrawn     (contributor drops after assignment)
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
API, and payouts — over the same test database.

### Environment (`.env`)

`.env.local`, when present, is loaded **before** `.env` and wins — useful for
local secrets you never want in the shared file. Remember it exists: a stale
`.env.local` silently overriding `.env` is a classic head-scratcher.

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
| `AGENT_MAX_PER_HOUR` | –      | Max conversational-agent turns per room per hour (group `/ai` mode, the stronger `AGENT_MODEL`) — bounds what a mention flood can spend (default `20`) |
| `SIGNAL_GLOBAL_MAX_PER_HOUR` | – | Global (all rooms) hourly cap on signal evaluations — the actual AI-bill ceiling, since rooms are free to create (default `200`) |
| `AGENT_GLOBAL_MAX_PER_HOUR` | – | Global (all rooms) hourly cap on agent turns, same rationale (default `200`) |
| `STALE_ASSIGNED_DAYS` | –     | Days an assignment can sit with nothing submitted before `/admin` counts it stale (default `7`) |
| `WEB_PORT` / `PORT` | –       | Port for the in-process Mini App web server (Railway injects `PORT`). Unset leaves the web tier off — the plain bot deployment is unchanged |
| `WEB_APP_URL`      | –        | Public HTTPS origin the Mini App is served from; wires the Telegram chat-menu / home-menu board buttons. Empty leaves them off |
| `NEAR_NETWORK`     | –        | NEAR network payouts settle on (default `testnet`)                                                                              |
| `DAO_CONTRACT_ID`  | –        | Sputnik DAO the push-payout model settles through (see `PAYOUTS.md`). Empty leaves the DAO path dormant |
| `OUTLAYER_API_KEY` | –        | OutLayer TEE-wallet key used to submit `add_proposal` (the only on-chain write the bot makes; the fund-moving key stays in the DAO). The single proposer path: empty → `/pay` refuses with guidance (no printed-command fallback — a replayable command was the root of the duplicate-proposal hazard). See `docs/outlayer-setup.md` |
| `OUTLAYER_BASE_URL` | –       | OutLayer endpoint; derived from `NEAR_NETWORK` when unset |
| `DAO_PROPOSAL_URL` | –        | URL template for viewing a proposal in a governance UI, `{id}` replaced by the proposal id (e.g. `https://dash.example.com/proposals/{id}`). Powers the verify-before-voting deep links on `/pay` and `/payouts`; empty shows ids without links |
| `SUPPORT_CONTACT`  | –        | Where a confused user or payout question reaches a human (an @handle, URL, or email) — surfaced in `/help`, `/privacy`, `/terms`, and the contributor payout view. Set it before a public launch |

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
- `/payto <your.near>` — set the NEAR account your payouts are sent to (DAO-push
  mode; validated to exist on-chain — also settable in the Mini App). Payments
  put this account + task ids on the public chain permanently. Approval DMs for
  rewarded work nudge this when no account is saved yet (with a pointer to
  getting a NEAR wallet)
- `/payouts` — **your** payouts: the status of money owed to you (queued /
  proposal open / paid), reconciled against the chain; for global admins the
  same command is the settlement queue (below)
- `/status <taskId>` — a task's public status and history (personal history events
  appear only in a DM; groups see task-level events only)
- `/privacy` — what the bot stores, retention, the AI data flow, and how erasure works
- `/terms` — the operator's plain-language terms: who curates tasks, who releases
  payment (the DAO council; its decision is final), no-employment, as-is
- `/forgetme` — file an erasure request with the operators (confirm-button gated;
  the erasure itself stays an admin-run `/forget` behind the money-in-flight guard)

**Admins** (must be in `ADMIN_IDS`)

- `/admin` — overview: counts of drafts, open tasks, pending applications, active
  assignments (including ones stale past `STALE_ASSIGNED_DAYS` with nothing
  submitted — the claim-and-abandon surface; free the slot via `/unassign`),
  submissions to review, and notification-queue health (pending / failed), each
  pointing at the command that acts
- `/newtask` — task-creation wizard (sets `max_assignees`; `/ai` drafts description/output)
- `/approve` — approve draft tasks (Draft → Open), announced to the channel if configured
- `/applicants <taskId>` — each applicant's pitch + track record; **Assign** / **Decline**
- `/active` — assignments in progress (assignee, submission state, age)
- `/review` — review submitted work (Approve / Reject / Revise, with a note); attachments
  re-sent, and a **📄 Full submission** button on any card that had to clip long content
- `/close <taskId>` / `/reopen <taskId>` — stop / resume accepting applications
- `/unassign <applicationId>` — remove an assignment (records a reason, notifies the contributor)
- `/payouts` — the settlement queue: payouts owed for approved rewarded work,
  reconciled against the chain per row — open DAO proposals (including
  approved-but-failed transfers needing a re-finalize)
- `/pay <taskId> <amountNEAR> [recipient.near]` — propose the payout as a DAO
  `Transfer` via the OutLayer TEE wallet (the single proposer path — needs
  `OUTLAYER_API_KEY`); a council vote releases the funds — the bot never moves
  money. Needs `DAO_CONTRACT_ID`; omitting the recipient uses the contributor's
  saved payout account
- `/stats` — the funnel at a glance: contributors and activation (ever applied),
  tasks created/open, applications, in-progress, completed, payouts paid/owed —
  all derived from the workflow tables (nothing new is recorded)
- `/diag` — config preflight: DB, announce-chat reachability, group privacy
  mode, DAO reachability, OutLayer key presence, web tier, AI. Run it after any
  deploy or env change — these are the settings that otherwise fail silently
  and late (a wrong announce chat surfaces as an announcement nobody sees)
- `/forget <contributorId>` — erase a contributor's data (profile, applications,
  submissions, payout ledger rows; history details scrubbed; task authorship
  cleared; notification rows to or about them purged). Refused while an open DAO
  `Transfer` proposal names the contributor's payout account — the council can
  still send it, so erasing its ledger row would strand NEAR on-chain.
  Contributors can file the request themselves with `/forgetme` (admins are
  alerted with the id to run)

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

Adding the bot to a group posts a welcome there (what it does, how to switch it
on) and DMs the inviter that they are now the room's first admin — the group
never starts silent. Enabling signals or AI mode when the bot can't actually
see member messages (default privacy mode, not a group admin) appends a
warning with the fix instead of failing silently.

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
it survives restarts and concurrent messages) → global hourly budget
(`SIGNAL_GLOBAL_MAX_PER_HOUR` — the actual AI-bill ceiling, since rooms are
free to create) → AI score → draft when the score
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
endpoint, under a per-room hourly turn budget (`AGENT_MAX_PER_HOUR`) plus a
global one across all rooms (`AGENT_GLOBAL_MAX_PER_HOUR` — the actual bill
ceiling, since rooms are free to create) — a mention flood draws one "budget
spent" notice and then silence, bounding the AI bill the same way the signal
caps bound scoring. Conversation memory
is RAM-only, bounded, and expires after minutes; ambient (unaddressed) chatter
is untouched unless signal detection is also on — the two features compose per
room.

## Notifications

Every bot-initiated push (announcements, alerts, outcome DMs) is **enqueued**, not
sent inline: command handlers return immediately, and a **single background worker**
drains the `notifications` queue. "Single" is enforced, not assumed: the worker
delivers only while holding a Postgres session advisory lock (leader election),
so a deploy-rollover overlap — two live containers for up to ~a minute — can't
double-deliver; the old holder's exit (or crash) frees the lock and the new
container takes over within seconds. This gives one **global** Telegram rate limiter
(one paced sender, never exceeding `NOTIFY_RATE_PER_SEC` across all broadcasts),
**retry with exponential backoff**, **429 flood-control** handling, and **restart
safety** — delivery status is persisted, so a restart resumes where it left off.
Delivery is at-least-once: a crash between a successful send and the status write
can duplicate that one message on restart; nothing is lost to a restart. `/admin`
surfaces queue health (pending / failed). Command *replies* to the acting user
stay synchronous; only pushes queue.

All notifications point back at the bot's commands — `/open` and `/myapps` are the
source of truth; a missed notification never loses state.

- **New task opened**: a *global* task announces to the channel (if configured) —
  the primary, O(1) discovery post, carrying a deep-link **Apply** button when
  `BOT_USERNAME` is set — plus opt-in DMs to contributors who ran `/notify on`.
  A *room* task announces only into its own group (see the scope model above).
  Approval returns immediately regardless of audience size.
- **New application**: every admin gets the applicant's pitch + track record with
  one-tap **Assign** / **Decline** buttons.
- **Application outcome**: the contributor is DM'd when assigned, declined, or
  unassigned (with the reason).
- **Waiting-state changes**: still-Applied applicants are DM'd when the task
  fills its last slot or is closed under them (once per application — a refill
  after an unassign doesn't re-ping), so nobody waits on a task that can't
  proceed. Assignees quietly approaching `STALE_ASSIGNED_DAYS` with nothing
  submitted get one pre-stale reminder (at stale−2 days, swept from the worker)
  before the assignment surfaces on `/admin` and risks an `/unassign`.
- **New submission**: reviewers get the work, its version, the contributor's track
  record, the original attachment, and (if enabled) an AI summary.
- **Review outcome**: the contributor is DM'd on approve / reject / revise.
- **Pre-stale reminder**: an assignee quiet for `STALE_ASSIGNED_DAYS − 2` days
  gets one nudge DM per assignment stint — before the assignment surfaces in
  `/admin`'s stale count and reaches `/unassign` territory.

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
task detail, your applications, and your payouts. Task-workflow mutations (apply,
submit, review) all stay in the bot — the app deep-links back into it. The one
exception is the contributor's own payout-account write: a typed NEAR account
(`POST /api/payout-account`), scoped to the initData-verified caller and
validated to exist on-chain. The oRPC read API is gated by
Telegram **initData** verification (identity, not entitlement: drafts are never
served), runs on the same Postgres pool and `src/core/` service layer, and is
caller-scoped — you can only read your own work. `web-smoke` covers the read API
(auth, caller scoping, payout listing); `dao-demo` covers the payout-account
service (`setPayoutAccount`, existence-checked) and the reconciler's abandoned-
claim auto-heal. Not in the gate (integration-tested
manually, via the `dao-*-live` scripts): the `/payto`, `/pay`, and `/payouts`
command handlers, the `POST /api/payout-account` success path (its on-chain
existence check), and a SUCCESSFUL OutLayer TEE submit (`src/near/outlayer.ts` —
dao-demo stubs the gateway as permanently down, so the offline gate drives the
claim/heal/adopt machinery, not a landing submit).

Approving rewarded work records a row in the **payout ledger** (same transaction
as the approval). **Settlement is push, through a Sputnik DAO** (see
[`PAYOUTS.md`](PAYOUTS.md) for the decision and design): an admin runs `/pay` to
propose a NEAR `Transfer`, the council votes, and the DAO executes it — the
contributor's only step is setting their payout account (`/payto`, or in
the Mini App). The bot proposes via a non-custodial **OutLayer
TEE wallet** (holding an `add_proposal`-only key, never a fund-moving one) — its
single proposer path; without it `/pay` refuses (the old printed-command fallback
was a replayable out-of-band command, the root of the duplicate-proposal hazard);
the reconciler then reads the final on-chain proposal status to settle the row
(`proposed → paid`, or back to `pending` if the proposal is rejected or its window
lapses — there is no terminal `declined` state).

**Privacy note:** proposing a payout writes the payout account and the task id
to the public NEAR blockchain — permanently. Nothing on-chain names the Telegram
identity, and `/forget` erases the stored account link between the two, but the
on-chain record is beyond erasure; `/privacy` discloses this, and the Mini App /
`/payto` surface it at the moment the account is set. `/forget` also refuses
while money is in flight — an open DAO `Transfer` proposal the council can still
approve.

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
   announcement / Mini App / payout variables. (`DATABASE_URL` comes from the plugin.)
3. Deploy with `railway up` (or connect the GitHub repo for deploys on push).
   `initSchema()` applies any pending migrations on boot — no manual step.

Only one process may poll a given bot token: `railway.json` pins
`numReplicas: 1` — don't raise it (polling and the global rate limiter both
assume one process) — and stop any local `npm run dev` against the same token
before deploying. For the same reason it sets `overlapSeconds: 0` (+ a 60s
drain): Railway's default zero-downtime rollout runs old and new containers
CONCURRENTLY, and two pollers on one token 409-crash each other and randomly
split (i.e. lose) updates for the whole overlap window. No overlap costs a few
seconds of Mini App downtime per deploy; a long-polling bot doesn't notice.

`railway.json` also wires the deploy health check to the web tier's `/healthz`
(DB reachability included). That assumes the Mini App is enabled (`PORT` set,
service exposed); for a bot-only worker deployment with no HTTP port, **delete
the `healthcheckPath` line** or every deploy will fail its health check.

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
3. **Failure signals** — `/admin` shows failed-notification counts, and global
   admins are DM'd (throttled) when deliveries exhaust their retries on
   transient errors. That covers delivery, not liveness: pair it with an
   external uptime check on `/healthz` (the web tier) or Railway's own alerts —
   the bot cannot report its own death. `/healthz` also reports
   `poller: up|backoff`, so an external check can catch the one wedge the
   process survives: the web tier green while long polling is stuck in the 409
   backoff loop receiving nothing (it's reported, not a 503 — a new container
   legitimately sits in backoff during a deploy rollover). The log line
   `gave up on notification` remains the forensic detail. Run `/diag` after any
   deploy or env change for the config-level checks.
4. Stop any local `npm run dev` on the production token before the first
   deploy (two pollers fight over updates).

**Data protection.** The Postgres database stores personal data — contributor
Telegram usernames, display names, and user IDs. Restrict access to the Railway
project and its Postgres plugin, and don't copy the database to untrusted
environments. Profiles are only created by a user-initiated act — DMing the bot
or setting a payout account in the Mini App; group members are never recorded
passively. `/privacy` states the retention rules to users, and `/forget` handles
deletion requests (deleting active rows immediately; managed backups age out per
the configured retention; an in-flight DAO payout proposal sequences erasure
behind the council's approval or rejection).

**Schema migrations.** The schema is a set of sequential, forward-only SQL files
in `db/migrations/` (`001_initial.sql`, `002_rooms.sql`, …), applied once each at
startup by `initSchema()` and tracked in a `schema_migrations` table (with a
checksum guard). To change the schema, add a new higher-numbered file — **never
edit an applied one** (see `db/migrations/README.md`). `npm run db:init` applies
pending migrations; `npm run db:reset` rebuilds the **local dev** database from
scratch (guarded — it refuses any `DATABASE_URL` that doesn't look local/test/CI).

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
                       room, signal, payout
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
                       typed payout-account write
  near/dao.ts          Sputnik DAO reads (proposals/policy) + Transfer-proposal builders
  near/outlayer.ts     non-custodial TEE wallet that submits add_proposal (no fund key)
  near/account.ts      typed-payout-account existence checks (NEAR view_account)
  index.ts             entry point (long polling; starts the worker + web server)
web/                   Mini App frontend (React + Vite)
```

The `core/` layer has **zero Telegram coupling** — the web tier (`src/web/`)
calls the same service functions the bot does.

## Not in this MVP (deferred)

Admin web dashboard (the Mini App is contributor-facing and read-mostly),
multi-channel support, automated
candidate scoring, task↔candidate matching, auto-assignment, deadline
automation beyond the pre-stale nudge (hard reminders/expiry), reward-amount
automation (rewards are free text,
e.g. `100 USDC`; a human resolves the on-chain amount at propose time),
agent memory beyond the in-RAM window, and advanced reputation/anti-fraud.

**Multi-tenancy is a different product, not a deferred feature.** The
single-treasury, single-proposer, single-admin-list decisions are load-bearing
(see PAYOUTS.md); "20 communities each with their own treasury and admins"
would need per-tenant DAOs, quotas, and isolation designed from scratch — don't
back into it by loosening the current model.
