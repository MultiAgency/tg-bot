# Agent instructions

Telegram bot (Telegraf + PostgreSQL via `pg`, TypeScript ESM, Node 22+) that
coordinates contributor work through a human-in-the-loop **apply → assign →
versioned submit → review** workflow, modelled as three state machines (task,
application, submission — see `src/core/workflow.ts`). Read `README.md` for
the full picture, `SCOPE.md` for what is deliberately out of scope.

## Commands

```bash
npm test                  # the full gate: typecheck (bot + web), build, all demo/smoke suites
npm run typecheck         # tsc --noEmit (bot); web:typecheck covers web/
npm run build             # tsc → dist/ + vite build → the Mini App bundle
npm run core-demo         # the service layer end-to-end (the state machines, no bot)
npm run demo              # end-to-end run of DEMO.md with the network stubbed
npm run queue-demo        # the notification delivery queue (retries, rate limit, dedup)
npm run edge-demo         # adversarial edges: Telegram limits, groups, races, migrations
npm run rooms-demo        # rooms, room admins, signal detection + AI mode (AI endpoint stubbed)
npm run agent-tools-demo  # the conversational agent's tool guards (visibility, apply mirror)
npm run web-smoke         # Mini App tier: initData auth, oRPC reads, payouts, payout account
npm run dao-check         # DAO proposal-status mapping (pure, no network/DB)
npm run dao-demo          # DAO-push settlement walk: propose → adopt → vote → settle (RPC stubbed)
npm run dev               # tsx watch (needs a real BOT_TOKEN in .env)
npm run db:init           # create + migrate the local docker-compose Postgres
npm run db:reset          # drop + recreate the local dev database
```

`npm test` is the check that matters — CI runs exactly it. `npm run demo`
drives the real middleware, scenes, and buttons against a throwaway database;
`core-demo` and `queue-demo` cover the service layer and delivery queue;
`edge-demo`'s transport stub rejects over-limit messages like the live API;
`rooms-demo` stubs the NEAR AI endpoint at `globalThis.fetch` (the real
OpenAI SDK client still runs) to drive signal detection deterministically;
and `dao-demo` stubs the NEAR JSON-RPC to walk the push-payout settlement path.

Three **live, out-of-gate** DAO scripts (real testnet DAO + env, run by hand via
`npx tsx`, never in `npm test`): `scripts/dao-live.ts` (read-only — prints policy
+ recent proposals), `scripts/dao-propose-live.ts` (real `proposePayout` through
the OutLayer TEE), and `scripts/dao-settle-live.ts` (headless reconcile of the
existing `proposed` queue — advance/settle a live payout after a council vote).

**Deploy checklist** (prod = Railway, `railway up` with the working tree):
1. `npm test` green.
2. `npm run ai-agent-smoke` — LIVE-model drift check (real NEAR AI key; outside
   the gate because it costs tokens). It hard-fails if the agent stops drafting
   from a fully-specified request.
3. `railway up --detach`; verify `/healthz`, `GET /config` (settlement flags as
   intended), `getWebhookInfo` (pending≈0), and the boot log.
4. Commands sent to the bot during the rollout window may be lost
   (`overlapSeconds: 0` minimizes it) — re-send anything important.

## Architecture rules

- **`src/core/` must not import from Telegraf or `src/bot/`.** It is the
  framework-free service layer both surfaces share — the bot and the Mini App
  tier (`src/web/`) call core, never the reverse.
- **The web tier is read-mostly.** Every task-workflow mutation (apply, submit,
  review) stays in the bot; the `src/web/api.ts` oRPC procedures only read,
  scoped to the initData-verified caller. The sole write endpoint is the
  caller's own payout account — `POST /api/payout-account` (typed NEAR account,
  DAO rail) — self-scoped and existence-checked on-chain. Adding any OTHER web
  mutation is an auth-model change; treat it as one.
- **Task visibility floor**: a Draft is never public — it may distill private
  group chatter no human approved for release. Any new surface that resolves a
  task by id must read through `isTaskPublic`/`getPublicTask` (service.ts) and
  answer hidden and missing ids identically (no existence oracles), widening
  only with its own checks (manager-in-DM, engaged applicant).
- **The conversational agent only proposes.** Its tools read, or render
  confirmation cards carrying the SAME buttons (`approve:`, `apply:`) and auth
  guards the classic commands use — a human tap performs every mutation. Don't
  add a tool that mutates directly.
- **All state changes go through `src/core/service.ts`**, which validates
  transitions against the tables in `src/core/workflow.ts` and records every
  step in `task_history` inside a transaction. Never update task, application,
  or submission status directly with SQL or model helpers from bot code.
  Service mutators enforce workflow rules but trust the caller to have gated
  *role* — new call paths must apply the admin/ownership check first.
- **AI (`src/ai/assist.ts`) is advisory only.** Helpers return `null` on any
  failure or missing key, and callers must degrade gracefully. AI output is
  never allowed to trigger a state transition. Signal detection creates
  *Drafts* only — the human `/approve` step is the boundary; never let a
  signal open a task.
- **Signals store no message text and no author identity.** A signal row is
  room + score + outcome, nothing else, and signal-drafted tasks keep
  `created_by = NULL` — `/privacy` promises that people who only chat in a
  group with the bot are never recorded. Don't add text/author columns to
  `signals` without treating it as a privacy change. The RAM-only room context
  window (`src/bot/roomContext.ts`) is **consent-gated**: it records only after
  the room's `signals_enabled` check in `handleGroupMessage` — never buffer
  chatter from rooms that haven't opted in, even in memory.
- **Role gating is room-aware.** Global admins (`ADMIN_IDS`) manage everything;
  room admins (`room_admins` table) manage only tasks whose `room_chat_id` is a
  room they administer — enforced in `src/bot/index.ts` via `canManageTask` /
  `requireManagerCmd` (commands) and `requireManageCb` (buttons). Task-scoped
  notifications fan out via `enqueueForManagers` (global admins ∪ that room's
  admins), not `enqueueForAdmins`. `/newtask`, `/admin`, and `/forget` stay
  global-admin-only.
- **Submissions are immutable versions** — a revision is a new row, never an
  update of the old one. The only deletion path is `/forget` (right-to-erasure),
  which must also scrub history *details* (pitches, "contributor N" mentions),
  not just actor links — see `eraseActor` in `src/core/models/history.ts`.
  Erasure yields to money: `forgetContributor` refuses while money is in flight —
  an open DAO `Transfer` proposal (status `proposed` with a live on-chain
  proposal the council can still approve). Cascading such a ledger row away would
  strand NEAR the council can still send. The guard reads the CHAIN, not just the
  ledger: the preflight reconciles each `proposed` row via
  `reconcilePayout`, fails CLOSED on an unreadable chain, and has a
  config-independent in-transaction backstop (`countByContributorStatus` on
  `proposed`) so a missing `DAO_CONTRACT_ID` can't open a gap. An abandoned
  claim (`proposed` with no on-chain `proposal_id`) holds erasure only until
  reconcile's grace window auto-heals it to `pending` — erasure is delayed, never
  lost, and never races a proposal that may still be mid-flight. Keep this guard
  ahead of any new cascade.
  Notification rows keep their rendered text after delivery, so `subjectId` is
  a **required** field on enqueue: name the contributor whose personal data the
  content carries, or pass `null` only for task-only content. That field is
  what lets erasure purge those rows (`deleteForContributor`) — tagging the
  wrong subject (or `null` on content that names someone) silently reopens the
  privacy gap.
- **Privacy in output**: non-admin `/status` filters history to task-level
  events, the viewer's own actions (actor), and events about them
  (`subject_id` — e.g. reviews of their work). Anything that names *other*
  contributors is admin-only. History writes about a contributor must pass
  `subjectId` to `addHistory` — except `contributor_forgotten`, which must not
  (the pointer would survive the erasure it records). Keep new surfaces
  consistent with this.
- File/screenshot/video submissions store genuine Telegram `file_id`s captured
  from media messages, never user-typed text — sendPhoto/sendDocument/sendVideo
  also accept URLs, so a typed "file" would be an SSRF vector. A file_id only
  replays through the method family it came from (a video file_id 400s through
  sendDocument), so new media types must extend the kind map in `notify.ts`.

## Gotchas

- Telegram limits: 4096 chars per message, 1024 per media caption. Compose
  outgoing text with the helpers in `src/bot/format.ts` (`clampMessage` is the
  final clamp) rather than sending raw strings.
- Telegraf handles a `getUpdates` batch concurrently; wizard session state is
  only safe because `perUserQueue` in `src/bot/index.ts` serializes per-user
  updates. Don't remove or bypass it.
- Wizard sessions are in-memory; durable state lives only in Postgres.
- Only one process may long-poll a bot token — never run two instances
  (including local dev against the deployed token).
- Signal detection only sees group texts if the bot is an admin of that group
  or global privacy mode is off — under the default privacy mode the listener
  simply never fires (no error, no log). The enable paths (`/enablesignals`,
  `/ai on`, the `/settings` taps) detect this (`can_read_all_group_messages` +
  a `getChatMember` self-check) and append a warning with the fix; keep that
  wired when touching the toggles.
- The DB layer (`src/core/db.ts`) runs on a `pg` Pool at READ COMMITTED, so a
  check-then-write is NOT atomic by default the way it was under synchronous
  better-sqlite3. A service mutator wraps its work in `withTransaction()`
  (nested calls join the outer transaction via AsyncLocalStorage — models never
  receive a client) and takes a row lock (`SELECT … FOR UPDATE`, see
  `getApplicationForUpdate` / `getTaskForUpdate` / `getRoomForUpdate` /
  `getContributorForUpdate`) on the row whose state it guards, as its FIRST
  read. New mutators must follow the same pattern or concurrent taps will
  double-apply.
- User-facing strings are being centralized in `src/bot/locales/` behind
  `t()`/`localeOf()` (`src/bot/i18n.ts`); prefer adding new strings there
  rather than inline.

## Environment

Copy `.env.example` → `.env`. `BOT_TOKEN` and `DATABASE_URL` are required
(startup throws without them); local dev and the demo suites use the
docker-compose Postgres (see README). An empty `ADMIN_IDS` only logs a
warning — the bot runs, but no one can create, approve, or review tasks. The
NEAR AI variables are optional (AI features switch off cleanly without them).
