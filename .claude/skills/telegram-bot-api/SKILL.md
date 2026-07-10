---
name: telegram-bot-api
description: Telegram Bot API + Telegraf reference for building and extending Telegram bots. Use when adding bot commands, keyboards, scenes/wizards, notifications, mini apps, inline mode, deep links, or webhooks; when debugging callback queries, formatting, privacy mode, or rate limits; or when working under src/bot/ in this repo.
---

# Telegram Bot API & Telegraf

Canonical sources (WebFetch when details below aren't enough or may have changed):
- Full API reference: https://core.telegram.org/bots/api
- Feature guide: https://core.telegram.org/bots/features
- Telegraf (this repo's framework): https://github.com/telegraf/telegraf

## Hard limits (memorize — silent failure modes)

Verified verbatim against Bot API 10.1 (June 2026); re-check the reference on major API bumps.

| Thing | Limit |
|---|---|
| Message text | **4096 chars** after entities parsing (longer → 400 error, message never arrives) |
| Media caption | **1024 chars** after entities parsing |
| Callback data (`callback_data`) | **1–64 bytes** |
| Command name | 1–32 chars, **lowercase** English letters, digits, underscores |
| Deep-link `start` payload | 1–64 chars, `A-Za-z0-9_-` (base64url for binary) |
| File download (`getFile`) | **20 MB** |
| File upload | **50 MB** multipart (10 MB for photos); only **20 MB** when sending by HTTP URL (5 MB photos); local Bot API server: unlimited download / 2000 MB upload |
| Send rate (guidance, not spec) | ~30 msg/s overall, ~1 msg/s per chat, 20 msg/min per group — exceeding it returns **429 with `retry_after`**; honor it |
| Inline keyboard | no documented count limit — oversized markup fails with a 400 `REPLY_MARKUP_TOO_LONG` server error (empirical, not in the reference); keep it modest (≲8/row renders well) |

Always truncate/clamp text you don't control before sending (this repo: field-level truncation inside `taskDetail()` and the `clampMessage()` send-boundary clamp, both in `src/bot/format.ts`).

## Non-negotiable interaction rules

- **Always `answerCbQuery()`** for every `callback_query`, even on error paths — otherwise the button spins for the user and BotFather sends conversion-rate alerts. Use `{ show_alert: true }` for errors the user must see.
- **Callback queries expire.** Answer promptly; answering one that's seconds-to-minutes old fails with 400 `query is too old … or query ID is invalid`. Wrap `answerCbQuery` in a `.catch()` so stale taps on old messages don't throw, and make button handlers idempotent — users retap old cards (e.g. a claim button on a task claimed long ago).
- **Bots cannot message a user first.** `sendMessage` to a user who never pressed Start → 403. Handle it; don't assume delivery (this repo: pushes go through the durable notification queue, which retries and records per-row delivery status).
- **`editMessageText` beats send+delete** for toggles/pagination; it throws if content is unchanged — swallow that specific error.
- **Global commands users expect:** `/start` (+ deep-link payload), `/help`, `/settings` (if applicable). Register the full list via `setMyCommands` so the `/` menu works; scopes allow per-group/per-language lists — but always re-validate authorization server-side (scope is cosmetic; updates may contain any command).
- **Group form of commands is `/cmd@BotName`** — match both (this repo: `isCommand()` in `src/bot/context.ts`).
- **`message.text` vs `message.caption`:** media messages carry `caption`, not `text`. Capture both or you lose user context.
- **`file_id` is bot-scoped:** a `file_id` obtained by one bot token cannot be sent by another (matters for test bots sharing a DB).

## Keyboards

- **Inline keyboards** (`Markup.inlineKeyboard` / `reply_markup.inline_keyboard`): buttons attached to a message; press → `callback_query` (or open URL / switch-inline / WebApp / pay). No message is sent to the chat.
- **Reply keyboards** (`ReplyKeyboardMarkup`): replace the user's keyboard with predefined answers; pressing sends the text. `one_time_keyboard: true` to auto-hide, `input_field_placeholder` to hint. Remove with `ReplyKeyboardRemove`.
- **Chat/user pickers:** `KeyboardButtonRequestChat` / `KeyboardButtonRequestUsers` on a reply keyboard → identifier arrives as a `chat_shared`/`users_shared` service message.

## Formatting

- `parse_mode: 'HTML'` is the safest (escape only `< > &`). `MarkdownV2` requires escaping ``_ * [ ] ( ) ~ ` > # + - = | { } . !`` — a leading cause of silent 400s. Plain text (no parse_mode) never fails — this repo currently uses plain text.
- Rich Messages (headings, tables, LaTeX, collapsible blocks) exist for structured content — see the features page.

## Telegraf specifics (v4, this repo)

- Middleware order matters: `session()` → your middleware → `stage.middleware()` → commands/actions. Scenes need session.
- **`bot.handleUpdate` creates a fresh `Telegram` instance per update** — to stub the network in tests, patch `Telegram.prototype.callApi`, not `bot.telegram` (see `scripts/demo-loop.ts`).
- `bot.launch()` resolves only when the bot **stops** — don't `await` it to detect startup.
- **Active scenes consume every update** (commands and callback taps included) before global handlers. Every wizard step must handle: `/cancel` (incl. `@BotName` form), stray commands, and button taps — this repo's `handledWizardInterrupt()` in `src/bot/context.ts` does all three; use it in any new scene step ≥ 1.
- `ctx.scene.enter(id, state)` passes state to step 0 via `ctx.scene.state`; per-wizard scratch lives on `ctx.wizard.state`.
- Photos arrive as an array of sizes — `msg.photo[msg.photo.length - 1]` is the largest.
- `bot.catch()` is the last-resort error handler — Telegraf's default rethrows, which surfaces as an unhandled rejection and can crash the whole process on a single bad update. Always register one.
- Test harness pattern: build updates with `bot_command` entities and call `bot.handleUpdate()`; set `bot.botInfo` manually since `getMe` is never called.

## Receiving updates

- **Long polling** (this repo): simplest; exactly one instance per token (two pollers → 409 Conflict).
- **Webhooks:** HTTPS on ports 443/80/88/8443, up to 100 connections; `bot.createWebhook()` in Telegraf. Call `deleteWebhook` before switching back to polling.
- **Privacy mode** (default ON in groups): bot only sees commands addressed to it, replies to it, and service messages. Admin bots see everything. Toggle via BotFather `/setprivacy` (re-add bot to group to apply).

## Beyond messaging (pointers relevant to this product)

- **Deep linking:** `https://t.me/<bot>?start=<payload>` → `/start <payload>`; `?startgroup=` for add-to-group. The natural mechanism for contributor invite/referral/onboarding links.
- **Inline mode:** `@bot query` from any chat → `inline_query` update → `answerInlineQuery`. Enable via BotFather `/setinline`. Candidate mechanism for sharing/amplifying tasks into other chats.
- **Mini Apps (WebApps):** full custom JS UI inside Telegram; a candidate surface for the future dashboard. See https://core.telegram.org/bots/webapps.
- **Web Login:** login widget or inline `login_url` button authenticates a Telegram user on a website — relevant to linking Telegram identity to the future web/API layer. Verify the auth hash server-side.

Payments (Telegram Stars), HTML5 games, stickers, and bot-to-bot/guest/secretary/managed modes are deliberately omitted — no use case in this product. Full catalog: https://core.telegram.org/bots/features.

## BotFather ops

`/newbot` (token), `/setcommands`, `/setdescription`, `/setabouttext`, `/setuserpic`, `/setprivacy`, `/setinline`, `/setdomain` (login widget), `/token` (regenerate a leaked token — do this immediately if a token lands in a commit). Test safely by running the code on a **second bot token**; a separate test *environment* also exists (`api.telegram.org/bot<token>/test/METHOD`).

## This repo's conventions

- Commands + callback actions live in `src/bot/index.ts`; multi-step input is a wizard scene in `src/bot/scenes/` registered in the `Stage`.
- Callback data format: `verb:id` (`assign:12`) or `verb:arg:id` (`rev:approve:12`) — parse with `bot.action(/regex/)`, keep under 64 bytes.
- Outbound messages that embed user content are size-bounded by `taskDetail()`'s field truncation; any newly composed message (e.g. detail + history) must pass through `clampMessage()` at the send boundary.
- Never claim delivery you didn't verify — bot-initiated pushes only enqueue;
  delivery status lives on the notification row (queue health surfaces in `/admin`).
- Verify changes end-to-end with `npm test` — `demo` drives the real bot layer
  with a stubbed network; `edge-demo` covers limits, groups, races, and backups.
