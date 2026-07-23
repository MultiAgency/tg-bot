# Scope — MVP

A working prototype that proves the core coordination loop over Telegram:

**create task → approve → announce → apply → assign → submit → review → record status & history**

The MVP prioritizes a narrow, testable workflow over broad automation. AI assists
with drafting, summaries, and review notes; **humans control every final decision**.

## Goal

A usable internal prototype that lets the team test whether MultiAgency can
coordinate contributor work through Telegram with a simple workflow engine.
It should answer three practical questions:

1. Can the team create, approve, and staff tasks quickly?
2. Can contributors discover, apply to, and submit tasks through Telegram?
3. Can reviewers track applications and submissions clearly enough to run a small pilot?

## In scope

### Telegram bot (Telegraf)

- Create task (admin wizard, including `max_assignees`), browse open tasks,
  apply with a pitch, submit versioned work, view status/history
- One-tap admin decisions: application cards carry **Assign/Decline** buttons,
  submission cards carry **Approve/Reject/Revise** buttons
- `/admin` — a counts-only overview (incl. notification-queue health) pointing
  at the commands that act
- Notifications for every hand-off (see README); all point back at `/open` /
  `/myapps`, the single source of truth. New-task announcements are
  room-scoped: a global task goes to the announcement channel (the primary
  discovery surface, with a deep-link Apply button) plus opt-in DMs
  (`/notify on`); a room task announces only into its own group and stays off
  every global discovery surface (global `/open`, inline search, the Mini App
  board) — the bot never amplifies a self-registered room beyond itself

### Notification pipeline

Every bot-initiated push is enqueued to a durable `notifications` table and
delivered by a **single background worker** — one global rate limiter, retry with
exponential backoff, Telegram 429 flood-control, and restart-safe at-least-once
delivery (persisted status; dedup keys). Approval and other handlers return
immediately after enqueueing, regardless of audience size. Command *replies* to
the acting user stay synchronous; only pushes queue.

### Workflow engine — three independent state machines

```
Task:         Draft ──approve──▶ Open ──close──▶ Closed ──reopen──▶ Open
                 └──discard──▶ deleted            (reject path: a draft may distill
                                                   unreleased group chatter — dismissing
                                                   it must not force an announcement)

Application:  Applied ──assign──▶ Assigned        (admin, up to max_assignees)
                 │  ──decline──▶ Declined          (not selected; re-apply allowed, new pitch)
                 │  ──withdraw─▶ Withdrawn
              Assigned ──withdraw──▶ Withdrawn     (contributor drops after assignment)
              Assigned ──unassign──▶ Applied       (admin, reason recorded)
              Assigned ──work approved──▶ Completed (terminal: slot stays consumed)
              Assigned ──work rejected──▶ Rejected (terminal: slot freed, no re-apply/re-assign)

Submission:   Submitted ──approve──▶ Approved      (each revision = a new version)
                        ──reject───▶ Rejected      (terminal — also closes the assignment)
                        ──revise───▶ Needs revision → contributor submits next version
```

Guard rails, enforced in `src/core/service.ts`:
- A task at `max_assignees` accepts no further applications (and `/open` shows
  it as fully assigned).
- One application per contributor per task; re-applying reuses it with the new pitch.
- A contributor holds at most `MAX_OPEN_APPLICATIONS` pending applications.
- An application with a submission awaiting review cannot leave Assigned
  (no withdraw/unassign) until the reviewer decides.
- A review decision atomically closes the assignment: approve moves the
  application to Completed (terminal; the slot stays consumed), reject moves it
  to Rejected (terminal; the slot frees and that contributor cannot re-apply to
  the task). Declined (not selected) permits re-apply; Rejected (work finally
  rejected) does not. Revise stays the recoverable outcome.
- Every transition is validated and recorded in `task_history`.

### Data model

Task (title, description, reward as free text, informational deadline, required
output, `max_assignees`, status), Application (contributor, pitch, status),
Submission (versioned: type, content, caption, status, reviewer note),
per-task history.

### Contributor profile & privacy

Telegram ID, username, display name, language code, and applied/assigned/
completed/rejected counts. Informational only — the counts are shown to admins
on application and review cards but never gate any action. A derived reputation
label (trusted/flagged) is deliberately deferred until real workflow data
exists to calibrate what the thresholds should mean. Right-to-erasure via
`/forget`: profile, applications, submissions, and payout ledger rows deleted;
history scrubbed of pitches and mentions; task authorship (`created_by`)
cleared. Money-before-erasure guard: `/forget` refuses while money is in flight —
an open DAO `Transfer` proposal (status `proposed` with a live on-chain proposal
the council can still approve). Erasing such a ledger row would strand NEAR
on-chain. The check reads the chain, not just the ledger status (the preflight
reconciles every `proposed` row), fails closed on an RPC error, and has a
config-independent in-transaction backstop — so a payout proposed on-chain but
not yet reconciled in the DB, or a missing `DAO_CONTRACT_ID`, still can't slip an
in-flight payout past erasure. The preflight reconciles EVERY payout row (not
only `proposed` ones): a healed claim sits `pending` but keeps the receiver+amount
of a submit whose proposal may still land late, so it is chain-checked too until
that memory expires (claim watching is time-bounded by NEAR tx validity —
`CLAIM_MEMORY_TTL_MS`, 48h), and a paid row is audited for a live duplicate of
its own transfer. (An abandoned claim only stops blocking once it auto-heals
past the ~10min grace or its memory expires — within the grace, /forget
deliberately waits with "try again shortly" rather than race a proposal that
may still be mid-flight. An out-of-band proposal that first lands *after* the
check is the council verify-before-vote residual — an external submission can't
be locked against.) One boundary: the DAO proposal lives
on the public NEAR chain permanently — it carries the payout account and a task
number, never the Telegram identity, and erasure deletes the stored link between
the two, but the on-chain record itself is beyond erasure. When `OUTLAYER_API_KEY`
is set, that proposal is signed by a third-party TEE service (OutLayer), which
receives the proposal payload (payout account + task id + amount) to sign on the
treasury's behalf — a processor in the money path; the bot holds no fund-moving
key. `/privacy` discloses both. Erased PII leaves
the live database immediately; copies in Railway's managed backups age out within
a bounded retention window (6-day daily snapshots, ~7-day point-in-time
recovery), so a `/forget` is fully effective across every copy within about a
week — the erasure guarantee the app no longer snapshots for itself. Non-admin
`/status` hides other people's application events.

### Submission & review flow

Text, link, file attachment, screenshot, or video (captions preserved; media
submissions carry genuine Telegram file ids, never user-typed references). Reviewers see the
work, its version, and the contributor's track record; decisions land in history
and notify the contributor.

### AI assistance (optional, NEAR AI Cloud)

Draft a task description, suggest a required-output spec, and summarize a
submission for the reviewer (noting possibly-missing requirements — observations,
never a verdict). AI never assigns, approves, or rejects.
The bot is fully functional without an API key.

### Rooms & room-scoped admins

Every group the bot joins is a **room**; whoever added the bot becomes its
first room admin, and more are added by reply (`/addroomadmin`). Room admins
manage their rooms' tasks (approve/assign/review/close/unassign, plus the
matching notifications) without an `ADMIN_IDS` entry. Task creation, `/admin`,
and `/forget` stay global-admin-only; DM-created tasks belong to no room.

### Signal detection (opt-in per group)

Where a room admin ran `/enablesignals` (announced publicly in the group), the
bot AI-scores messages and auto-creates **Draft** tasks from promising ones —
prefilter → per-room hourly budget (`SIGNAL_MAX_PER_HOUR`) → AI score gate
(`SIGNAL_SCORE_THRESHOLD`). Each message is scored with a short window of recent
room chatter as context, so a draft can pick up a deadline or scope mentioned a
few lines earlier. Humans approve every draft; AI never opens a task.
Privacy: message text is processed then dropped, never written to storage — the
context window is RAM-only, bounded, and evicted (never persisted); the author is
recorded nowhere (signal rows are room + score + outcome only), preserving the
/privacy promise that group-only users are never recorded.

### AI mode (opt-in per group)

Where a room admin ran `/ai on` (`/ai status` shows it), members can talk to the
bot in **natural language** by addressing it — an @mention or a reply to one of
its messages. It answers and *proposes* actions via tool use — task drafts and
applications shown as confirmation cards a human still taps (the agent never
mutates on its own; the same approve/apply buttons and auth guards as the classic
commands). It runs on a stronger tool-calling model (`AGENT_MODEL`, default
`anthropic/claude-haiku-4-5`) than signal scoring, on the same NEAR AI endpoint.
AI mode and signal detection **compose**: addressed messages go to the agent,
everything else is ambient chatter left for signal detection (if also on) — a
room can run both, one, or neither. Privacy: the agent's short multi-turn memory
is RAM-only and never persisted; because a member is deliberately addressing the
bot, a task they draft records them as its author (unlike a passively-detected
signal, which records no one).

## Out of scope (later phases)

- Full candidate scoring through Twitter and Telegram
- Task↔candidate matching engine (applications are the seam it will attach to)
- Auto-assignment (revisit if pilot data shows apply→assign latency is the bottleneck)
- Automated reward optimization (rewards stay free text, e.g. `100 USDC`; the
  payout ledger snapshots them and a human resolves the on-chain amount at propose time)
- Deadline automation — expiry and escalation stay out of scope; acting on a
  stale assignment stays human via `/unassign`. Two bounded surfacing pieces
  ARE in scope (shipped 2026-07-21): `/admin` counts assignments stale past
  `STALE_ASSIGNED_DAYS` with nothing submitted, and a one-per-stint pre-stale
  reminder DM nudges the assignee two days before that threshold — a fair
  warning so the first staleness signal isn't the unassignment itself
- Agent memory
- Campaign planning
- Advanced reputation / anti-fraud beyond the application cap
- Automated amplification
- URL-to-file conversion pipeline
- Multi-channel support beyond Telegram
- Admin web dashboard (the Mini App is contributor-facing and read-mostly; the
  `src/web/` tier over the framework-free `src/core/` is the seam)

## Post-pilot simplification review (accretion watch)

Accretion is invisible to per-change review — every layer below passed review
because each was locally justified. This list is the counterweight: after the
pilot has real usage, each item is measured against its kill criterion and
either earns its keep or is removed in one deliberate simplification pass.
All answers come from existing tables and logs — no new analytics (see the
data-model rule). Until then: no new layers on these stacks without amending
this file first.

| Layer | Kill criterion (measure post-pilot) |
| ----- | ----------------------------------- |
| Inline share mode + Share button | Zero inline queries served → remove (or never enable inline mode in BotFather) |
| Classic toggle commands vs `/settings` panel | Whichever surface `signals`/`ai` toggles never arrive through → retire it (keep read-only status commands) |
| `/notify on` announcement DMs | Opt-in count ~0 (one query on `contributors.announce_opt_in`) → remove toggle + fan-out |
| Contributor-side `/ai` tools (browse/apply via chat) | Agent-turn logs ~all admin-drafting → narrow the toolset to drafting |
| `max_assignees > 1` | No multi-slot task ever created (one query) → collapse the slots machinery |
| Reputation counters on cards | Still gating nothing and uncited by admins → drop from cards until the derived label ships |
| Env-knob triplication (config.ts + .env.example + README table per var) | Standing cost, not a kill — but any knob never tuned from its default is a candidate to hard-code |

Known era-strata recorded elsewhere (no action): migrations carry two full
create→drop lifecycles (escrow-era `wallet_links`, watched-set
`payout_superseded_claims` — see db/migrations/README); reward free-text vs
pinned yocto amount is the documented promise-vs-payment gap (pre-mainnet item).

## Trust model (stated, not implied)

Operator-curated tasks, council-backed payouts. Global tasks come only from the
operator's global admins; a room's tasks come from its own admins and reach only
that room. There is deliberately no open task-posting, no owner/admin
reputation, no dispute process, and no sybil defense beyond the per-account
application cap — the trust anchors are the human review step, the room-scoping
of announcements, and the DAO council's vote before any money moves. Advanced
reputation / anti-fraud stays out of scope (above) until real workflow data
motivates it.

## Boundaries to preserve

- `src/core/` stays free of Telegram imports — it is the seam for a future API.
- All mutations go through `src/core/service.ts`, inside transactions, with history.
- AI output is always advisory: suggestions and notes, never a state transition.
  (Signal detection creates *Drafts* — the human approval step is the boundary.)
- Signals store no message text and no author identity — only room, score, and
  outcome. Widening that is a /privacy change, not a schema tweak.
- Notifications never carry state — `/open` and `/myapps` are canonical.
- All durable state lives in PostgreSQL; the process is disposable. (The only
  in-memory state is in-flight wizard sessions and the deliberately RAM-only AI
  state — agent conversations, the room context window, the agent's hourly
  budget counters. A restart loses those, never task data; for the AI state,
  never persisting it is the privacy design, not an accident.)

## Done when

An internal pilot (see `DEMO.md`) runs the full loop 3–5 times across two real
Telegram accounts — including at least one decline with re-apply, one revision
cycle, and one withdraw or unassign — with `/status` showing a complete,
accurate history for each task. Known limitations are documented (`DEMO.md`).
