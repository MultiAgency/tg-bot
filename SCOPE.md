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
  `/myapps`, the single source of truth. New-task announcements go to the
  announcement channel (the primary discovery surface, with a deep-link Apply
  button) plus opt-in DMs (`/notify on`)

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

Application:  Applied ──assign──▶ Assigned        (admin, up to max_assignees)
                 │  ──decline──▶ Declined          (not selected; re-apply allowed, new pitch)
                 │  ──withdraw─▶ Withdrawn
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
`/forget`: profile, applications, and submissions deleted; history scrubbed of
pitches and mentions; task authorship (`created_by`) cleared. Non-admin `/status`
hides other people's application events.

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

## Out of scope (later phases)

- Full candidate scoring through Twitter and Telegram
- Task↔candidate matching engine (applications are the seam it will attach to)
- Auto-assignment (revisit if pilot data shows apply→assign latency is the bottleneck)
- Automated reward optimization; payouts (rewards are free text, e.g. `100 USDC`)
- Deadline automation — reminders, expiry, escalation
- Agent memory
- Campaign planning
- Advanced reputation / anti-fraud beyond the application cap
- Automated amplification
- URL-to-file conversion pipeline
- Multi-channel support beyond Telegram
- Web dashboard (the `src/core/` service layer is framework-free so an API/web
  layer can be added later without rework)

## Boundaries to preserve

- `src/core/` stays free of Telegram imports — it is the seam for a future API.
- All mutations go through `src/core/service.ts`, inside transactions, with history.
- AI output is always advisory: suggestions and notes, never a state transition.
- Notifications never carry state — `/open` and `/myapps` are canonical.
- All durable state lives in the SQLite file; the process is disposable. (The
  only in-memory state is in-flight wizard sessions — a restart loses wizard
  progress, never task data.)

## Done when

An internal pilot (see `DEMO.md`) runs the full loop 3–5 times across two real
Telegram accounts — including at least one decline with re-apply, one revision
cycle, and one withdraw or unassign — with `/status` showing a complete,
accurate history for each task. Known limitations are documented (`DEMO.md`).
