# Maintainer Update: dev Branch

## Implemented

- Structured AI review notes: reviewer summaries now parse JSON into summary, requirement checks, missing items, risks, questions, and confidence.
- AI review metadata audit: task history records model, prompt version, parse status, and confidence without duplicating raw submission text.
- Signal rationale: AI signal drafts include score, confidence, and a short admin-facing reason.
- Safer review UX: terminal Reject requires confirmation; Revise remains the recoverable path.
- Safer DAO payout UX: `/pay` previews amount, recipient, and advertised reward before creating a DAO proposal.
- Payout audit trail: proposal creation, adoption, and pending verification are recorded in task history.
- Admin env compatibility: `ADMIN_TELEGRAM_IDS` is accepted as a legacy alias, while `ADMIN_IDS` remains preferred.
- Diagnostics: `/diag` reports admin env source, AI models, prompt version, and per-room/global AI caps.
- Parser test: `npm run ai-parser-check` validates AI review JSON parsing without calling the model.

## Good Parts

- Human-in-the-loop workflow is strong: AI drafts, summarizes, and suggests, but humans approve tasks, applicants, submissions, and payouts.
- State changes are mostly transactional and use row locks for race-sensitive decisions.
- Payout flow has a conservative double-pay posture: it fails closed when proposal state cannot be verified.
- Privacy posture is explicit: group signal content is processed then dropped; only score/outcome metadata is stored.
- Notification delivery is queued, rate-limited, and resilient to restarts.

## Weak Parts / Remaining Work

- Full integration tests still need a reachable Postgres and Telegram/DAO test environment.
- AI memory is RAM-only; this is privacy-friendly but means group AI loses short context on restart.
- AI parser coverage is still focused on review notes; signal parser and tool-call behavior need more direct tests.
- `/pay` success path still needs a live OutLayer/DAO smoke test after deployment.
- Secrets must be rotated if they were pasted into shared logs or tickets.

## Deployment Checks

- Set `BOT_TOKEN`, `ADMIN_IDS` or `ADMIN_TELEGRAM_IDS`, and `DATABASE_URL` in Railway.
- Set `NEAR_AI_API_KEY` only when AI features should be enabled.
- Set `DAO_CONTRACT_ID` and `OUTLAYER_API_KEY` only when DAO payout proposing should be live.
- Deploy `dev`, then run `/diag`.
- Smoke test: create task, approve, apply, assign, submit, review approve/revise/reject, then test `/payouts` and `/pay` if DAO is configured.
