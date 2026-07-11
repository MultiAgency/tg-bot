---
name: verify
description: How to drive this Telegram bot end-to-end without a live bot token — real Telegraf stack with the transport stubbed.
---

# Verifying this bot

The user surface is Telegram; there is no test account. The deepest reachable
surface is Telegraf's real update boundary: feed update objects through
`bot.handleUpdate(...)` and stub the HTTPS transport at
`Object.getPrototypeOf(bot.telegram).callApi`. Everything else — middleware,
per-user queue, sessions, scenes, i18n, Postgres, the notification worker — runs
for real. `scripts/harness.ts` holds the shared transport stub and update
factories; `scripts/demo-loop.ts` is the canonical example of the technique, and
`scripts/edge-demo.ts` (npm run edge-demo) is the adversarial variant — its
stub throws on over-limit messages like the live API, and it covers groups,
albums, erasure races, and migrations. Extend it rather than writing a scratch
driver when verifying new edge behavior.

## Recipe

- Write a driver script (`.mts` for top-level await) — the scratchpad works;
  import repo sources by absolute path with explicit `.ts` extensions
  (`await import('/abs/path/src/bot/index.ts')`) and run with `npx tsx` from
  the repo root so `node_modules` resolves.
- Env: `BOT_TOKEN=000000:verify DATABASE_URL=postgresql://multiagency:multiagency@localhost:5455/multiagency_test ADMIN_IDS=1
  BOT_USERNAME=DemoBot NEAR_AI_API_KEY= NOTIFY_RATE_PER_SEC=1000`
  (empty AI key disables AI; high rate makes worker pacing ~1ms). Point
  DATABASE_URL at the throwaway test DB (docker compose provides it). Start each
  run with `await resetDb()` (from `scripts/testdb.ts`) for a clean schema — it
  DROPs and recreates `public`, guarded so it only runs against a local/test URL.
- Set `bot.botInfo = { id: 999, is_bot: true, first_name: 'X', username: 'DemoBot' }`
  or command parsing breaks.
- Make the `callApi` stub **throw on `text.length > 4096` and
  `caption.length > 1024`** like the real Bot API — otherwise oversized
  messages "pass" that would 400 in production. Record every call
  (`method`, `chat_id`, `text`/`caption`, `photo`/`document` file id) into an
  array and assert on slices of it.
- Update shapes: messages need `from`, `chat` (`type: 'private'` or
  `'supergroup'` for group behavior), and for commands an
  `entities: [{ offset: 0, length: ..., type: 'bot_command' }]`. Photos:
  `photo: [{file_id, width, height}, ...]` (+ optional `media_group_id`,
  `caption`). Buttons: `callback_query` with `data` and a stub `message`.
- Queue behavior: producers only enqueue; call
  `drainNotifications(bot.telegram)` (from `src/bot/worker.ts`) to deliver.
  To test races, set the harness's `onApi` hook (awaited inside the `callApi`
  stub), so an async mutation like `forgetContributor()` fired mid-send commits
  before the next delivery.

## Flows worth driving

- Wizards (newtask/apply/submit/review/unassign): scene state persists across
  updates — always probe `/cancel` from inside a prompt.
- Group vs private: admin commands are gated to private chats
  (`requireAdminCmd`); `/status` is public but member-filtered outside DMs.
- Erasure: `/forget` must also cover queued notifications — drain after.
