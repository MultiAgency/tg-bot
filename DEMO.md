# Pilot / Demo Script

End-to-end run-through for the internal pilot. You need **two Telegram accounts**:
one admin (its numeric ID in `ADMIN_IDS`) and one contributor (any account).

## Setup (once)

1. `cp .env.example .env`, set `BOT_TOKEN` and `ADMIN_IDS` (optionally
   `NEAR_AI_API_KEY`, `ANNOUNCE_CHAT_ID`, and `BOT_USERNAME`).
2. `npm install && docker compose up -d` (starts local Postgres), then `npm run dev`
   (migrations apply automatically on boot).
3. Both accounts open **@MultiAgencyAI_bot** and send `/start`.

## The loop (~4 minutes per task)

| # | Who | Action | Expect |
|---|-----|--------|--------|
| 1 | Admin | `/newtask`, answer the wizard — try `/ai` at the description step; set max assignees (e.g. `1`) | "✅ Draft created" |
| 2 | Admin | `/approve`, tap **✅ Approve & open** | Task shows 📢 Open; the announcement channel posts (with a deep-link **Apply** button when `BOT_USERNAME` is set); `/notify on` contributors also get a DM. Delivery is queued and rate-limited — approval returns instantly |
| 3 | Contributor | `/open`, tap **🙋 Apply**, send a short pitch | "✅ Applied…"; every admin gets the pitch + track record with **Assign / Decline** buttons |
| 4 | Admin | Tap **✅ Assign** on the application card | Contributor is DM'd "You've been assigned — use /myapps" |
| 5 | Contributor | `/myapps` → tap **Submit**, send text / link / file / screenshot / video | "✅ Submitted (v1)…"; reviewers get the card + attachment + AI note |
| 6 | Admin | Tap **🔁 Revise**, add a note | Contributor is DM'd the note; `/myapps` shows Needs revision |
| 7 | Contributor | `/submit` again with the revision | v2 submitted; reviewers notified again |
| 8 | Admin | Tap **✅ Approve** | Contributor gets the approval + reward text |
| 9 | Anyone | `/status <taskId>` | Task detail + history (non-admins see task-level events, their own actions, and outcomes concerning them — never other contributors') |
| 10 | Admin | `/admin` | Counts of drafts / open / applications / active / to-review, each pointing at its command |

Run the loop 3–5 times, including at least one **Decline** (step 4 → 🚫 — the
contributor can re-apply with a new pitch) and one **Reject** (step 8 → ❌) to
see the rejected counter increment. **Reject is terminal** — the submission and
the assignment both close (application → ❌ Rejected), the slot frees for
someone else, and that contributor cannot re-apply or be re-assigned to the
task; use **Revise** (step 6) when you want another version instead.

## Recovery paths (try these once)

- **Withdraw**: an applied row in `/myapps` carries a **Withdraw** button; an
  assignment is withdrawn with `/withdraw <applicationId>`. Both are blocked with a
  clear error while a submission is awaiting review — the reviewer decides first.
  (`/myapps` only ever shows a button that will succeed — Submit when work is due,
  Withdraw while applied — never on a finished or awaiting-review row.)
- **Unassign**: admin `/unassign <applicationId>` — a reason is required, recorded,
  and DM'd to the contributor; the slot frees and they return to the applicant pool.
- **Close / reopen**: `/close <taskId>` stops new applications (assigned work can
  still be submitted and reviewed); `/reopen <taskId>` resumes.
- **Slots full**: when assignments reach `max_assignees`, the task stays visible in
  `/open` marked "Fully assigned" with no Apply button, and stale Apply taps are refused.
- **Erasure**: `/forget <contributorId>` deletes their profile, applications, and
  submissions, scrubs their pitches and mentions from task history, clears
  their id from the `created_by` of any tasks they authored, and purges every
  notification row addressed to or about them (queued or already delivered —
  rendered text carries their pitch and name).

## Beyond the core loop (optional)

- **Groups**: add the bot to a group — it becomes a *room* and the inviter its
  first room admin. `/settings` (or `/enablesignals` / `/ai on`) toggles signal
  detection and AI mode; each flip posts a public notice in the group. In an
  AI-mode room, @mention the bot (or reply to it) to browse tasks and apply
  conversationally — it only ever proposes cards a human still taps.
- **Mini App**: with `WEB_PORT`/`PORT` and `WEB_APP_URL` set, the chat menu
  button opens the read-mostly board (open tasks, your work, payouts); a NEAR
  payout account is set from the Payouts screen.
- **Payouts**: approve a rewarded task; the contributor sets a payout account
  with `/payto <account>`. Admin `/payouts` shows the queue, and `/pay <taskId>
  <amount>` proposes a DAO `Transfer` — the council approves it, and re-running
  `/payouts` reconciles the row to `paid`.

## Known limitations (MVP)

- Two admin tiers: everyone in `ADMIN_IDS` manages everything; room admins
  (added per group) manage their rooms' tasks. No finer role split within a tier.
- Signal detection needs the bot to receive group texts — promote it to admin
  in the scanned group (recommended) or turn BotFather privacy mode off.
- Rewards are free text. Approving rewarded work records a payout row; settlement
  is **push via a Sputnik DAO** (see `PAYOUTS.md`): an admin `/pay`s to propose a
  `Transfer`, the council approves it, and the DAO executes the transfer. The
  pilot can run with the DAO path off (no `DAO_CONTRACT_ID`) — payouts stay
  recorded but unsettled.
- Deadlines are informational text; nothing expires or reminds automatically.
- Long-polling single instance; don't run two copies against one token.
- AI notes cover text/link submissions and media captions (raw files, screenshots, and videos are passed through for human review).
- Anti-abuse guards: the application cap (`MAX_OPEN_APPLICATIONS`, default 5
  pending per contributor) plus per-room hourly AI budgets
  (`SIGNAL_MAX_PER_HOUR`, `AGENT_MAX_PER_HOUR`) bounding what a flooded or
  hostile group can spend. Nothing finer-grained than those.
- `/open` is a single-card browser — flip tasks with ◀ ▶ (the card edits in
  place), **Share** one into any chat via inline mode. Row-per-message lists
  (`/myapps`, `/review`, `/payouts`) cap a page at 15 rows with a "showing
  N of M" notice or a Next-page button.
- Delivered/failed notification rows are pruned after 30 days (queued rows never
  are) — enough to debug delivery, without an unbounded archive.
- New-task announcements go to the announcement channel (the primary discovery
  surface) plus opt-in DMs (`/notify on`). All bot-initiated notifications flow
  through a durable queue drained by a single background worker with one global
  rate limit, retries with backoff, 429 handling, and restart-safe delivery;
  `/admin` shows queue health. Delivery is at-least-once (a crash mid-send can
  re-deliver a single message); Telegram has no idempotency key to make it exactly-once.

The queue/worker has its own coverage — `npm run queue-demo` exercises delivery,
dedup, retry→failure, 429 flood-control, restart-safety, and media.
