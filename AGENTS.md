# Agent instructions

Telegram bot (Telegraf + better-sqlite3, TypeScript ESM, Node 22+) that
coordinates contributor work through a human-in-the-loop **apply → assign →
versioned submit → review** workflow, modelled as three state machines (task,
application, submission — see `src/core/workflow.ts`). Read `README.md` for
the full picture, `SCOPE.md` for what is deliberately out of scope.

## Commands

```bash
npm test            # the full gate: typecheck, build, then all four demo suites
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm run demo        # end-to-end run of DEMO.md with the network stubbed
npm run edge-demo   # adversarial edges: Telegram limits, groups, races, backups
npm run dev         # tsx watch (needs a real BOT_TOKEN in .env)
```

`npm test` is the check that matters — CI runs exactly it. `npm run demo`
drives the real middleware, scenes, and buttons against a throwaway database;
`core-demo` and `queue-demo` cover the service layer and delivery queue; and
`edge-demo`'s transport stub rejects over-limit messages like the live API.

## Architecture rules

- **`src/core/` must not import from Telegraf or `src/bot/`.** It is the
  framework-free service layer a future API will reuse. Bot code calls core,
  never the reverse.
- **All state changes go through `src/core/service.ts`**, which validates
  transitions against the tables in `src/core/workflow.ts` and records every
  step in `task_history` inside a transaction. Never update task, application,
  or submission status directly with SQL or model helpers from bot code.
  Service mutators enforce workflow rules but trust the caller to have gated
  *role* — new call paths must apply the admin/ownership check first.
- **AI (`src/ai/assist.ts`) is advisory only.** Helpers return `null` on any
  failure or missing key, and callers must degrade gracefully. AI output is
  never allowed to trigger a state transition.
- **Submissions are immutable versions** — a revision is a new row, never an
  update of the old one. The only deletion path is `/forget` (right-to-erasure),
  which must also scrub history *details* (pitches, "contributor N" mentions),
  not just actor links — see `eraseActor` in `src/core/models/history.ts`.
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
- Wizard sessions are in-memory; durable state lives only in SQLite.
- Only one process may long-poll a bot token — never run two instances
  (including local dev against the deployed token).
- The DB layer (`better-sqlite3`) is synchronous by design, and the whole
  service layer with it. Don't introduce an async DB driver casually — it
  ripples through every caller.
- User-facing strings are being centralized in `src/bot/locales/` behind
  `t()`/`localeOf()` (`src/bot/i18n.ts`); prefer adding new strings there
  rather than inline.

## Environment

Copy `.env.example` → `.env`. `BOT_TOKEN` is required (startup throws without
it). An empty `ADMIN_IDS` only logs a warning — the bot runs, but no one can
create, approve, or review tasks. The NEAR AI variables are optional (AI
features switch off cleanly without them).
