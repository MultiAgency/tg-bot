/**
 * Shared Telegraf test harness for the demo suites (demo-loop, edge-demo,
 * rooms-demo): one transport stub and one set of inbound-update factories, so
 * the fabricated update shapes can't drift between suites.
 *
 * The stub enforces the live Bot API's size limits by THROWING on >4096-char
 * messages and >1024-char captions — a suite that only "passes" because its
 * stub is laxer than production would hide real 400s.
 */
import { Telegram } from 'telegraf';

/** Console chrome shared by the demo transcripts. */
export const step = (t: string): void => console.log(`\n▶ ${t}`);
export const ok = (t: string): void => console.log(`  ✅ ${t}`);

// The subset of HTML tags Telegram accepts in parse_mode:'HTML' (a superset of
// what the bot emits — b, code, blockquote). Anything else is a 400 in prod.
const ALLOWED_HTML_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler', 'span',
]);

/**
 * Validate a string the bot sent with parse_mode:'HTML' the way Telegram's
 * server would: only allowed tags, properly balanced, and every '<' '>' '&' is
 * either part of a tag or a well-formed entity. Throws otherwise. The demo
 * transport calls this so an unescaped title or a dropped closing tag fails a
 * suite loudly here instead of silently 400ing (or worse, injecting) in prod —
 * the stub, again, being no laxer than the live API (see file header).
 */
export function assertValidHtml(s: string, method: string): void {
  const stack: string[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === '&') {
      const m = /^&(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/.exec(s.slice(i));
      if (!m) throw new Error(`${method}: unescaped '&' near ${JSON.stringify(s.slice(i, i + 24))}`);
      i += m[0].length;
    } else if (ch === '>') {
      throw new Error(`${method}: stray '>' near ${JSON.stringify(s.slice(Math.max(0, i - 12), i + 12))}`);
    } else if (ch === '<') {
      const m = /^<(\/?)([a-zA-Z][a-zA-Z-]*)([^>]*)>/.exec(s.slice(i));
      if (!m) throw new Error(`${method}: unescaped '<' near ${JSON.stringify(s.slice(i, i + 24))}`);
      const [full, closing, name] = m;
      const tag = name.toLowerCase();
      if (!ALLOWED_HTML_TAGS.has(tag)) throw new Error(`${method}: unsupported tag <${closing}${tag}>`);
      if (closing) {
        const top = stack.pop();
        if (top !== tag) throw new Error(`${method}: </${tag}> closes <${top ?? 'nothing'}>`);
      } else {
        stack.push(tag);
      }
      i += full.length;
    } else {
      i += 1;
    }
  }
  if (stack.length) throw new Error(`${method}: unclosed <${stack.join('>, <')}>`);
}

export interface Outbound {
  method: string;
  chatId: number | string | undefined;
  /** Human-readable text: HTML tags stripped and entities decoded, so substring
   *  assertions read what the user sees (`#1`, not `#<code>1</code>`). */
  text: string;
  /** The raw text/caption as sent, tags and entities intact — for HTML-specific assertions. */
  html: string;
  fileId?: string;
  /** reply_markup verbatim — lets suites assert button wiring (callback vs URL deep link). */
  replyMarkup?: unknown;
  /** answerInlineQuery results verbatim — lets suites assert inline-mode search output. */
  results?: unknown[];
}

/** Strip HTML tags and decode the entities the bot emits — the user-visible text. */
function htmlToPlain(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&'); // last, so a literal "&amp;amp;" doesn't over-decode
}

export interface HarnessUser {
  first_name: string;
  username: string;
}

/** The minimal bot surface the harness needs — any Telegraf<Ctx> satisfies it. */
interface HarnessBot {
  handleUpdate: (update: never) => Promise<unknown>;
}

export function createHarness(
  bot: HarnessBot,
  users: Record<number, HarnessUser>,
  opts: {
    /** Called on every outbound API call, before it's recorded. Shown chrome (demo-loop's narrator) lives here. */
    log?: (entry: Outbound, method: string, payload: Record<string, unknown>) => void;
  } = {},
) {
  const botUser = { id: 999, is_bot: true, first_name: 'Demo', username: 'DemoBot' };
  (bot as unknown as { botInfo: unknown }).botInfo = botUser;

  const outbound: Outbound[] = [];
  const apiErrors: string[] = [];
  // Race-injection hook: fires inside the transport before a send is recorded.
  // Set it to erase a contributor mid-batch, throw a fabricated 429, etc.
  const onApi: { current: ((method: string, payload: Record<string, unknown>) => void | Promise<void>) | null } = {
    current: null,
  };
  let msgId = 5000;
  let updateId = 1;

  (Telegram.prototype as unknown as { callApi: (m: string, p: Record<string, unknown>) => Promise<unknown> }).callApi =
    async (method, payload) => {
      const text = typeof payload.text === 'string' ? payload.text : undefined;
      const caption = typeof payload.caption === 'string' ? payload.caption : undefined;
      if (text !== undefined && text.length > 4096) {
        apiErrors.push(`${method}: message is too long (${text.length})`);
        throw new Error('400: Bad Request: message is too long');
      }
      if (caption !== undefined && caption.length > 1024) {
        apiErrors.push(`${method}: caption is too long (${caption.length})`);
        throw new Error('400: Bad Request: message caption is too long');
      }
      if (payload.parse_mode === 'HTML') {
        try {
          if (text !== undefined) assertValidHtml(text, method);
          if (caption !== undefined) assertValidHtml(caption, method);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          apiErrors.push(message);
          throw new Error(`400: Bad Request: ${message}`);
        }
      }
      await onApi.current?.(method, payload);
      const fileId = (payload.photo ?? payload.document ?? payload.video ?? payload.video_note) as
        | string
        | undefined;
      const raw = text ?? caption ?? '';
      const entry: Outbound = {
        method,
        chatId: payload.chat_id as number | string | undefined,
        text: htmlToPlain(raw),
        html: raw,
        fileId,
        replyMarkup: payload.reply_markup,
        results: method === 'answerInlineQuery' ? (payload.results as unknown[]) : undefined,
      };
      outbound.push(entry);
      opts.log?.(entry, method, payload);
      if (method === 'answerCallbackQuery' || method === 'editMessageText') return true;
      return { message_id: msgId++, chat: { id: payload.chat_id ?? 0 }, date: 0, text: text ?? '' };
    };

  const from = (id: number) => ({ id, is_bot: false, ...users[id] });
  const privateChat = (id: number) => ({ id, type: 'private', first_name: users[id].first_name });

  // Outbound-inspection helpers: `since` slices the recorded sends after a mark,
  // `repliesTo` narrows them to the text messages a given chat received.
  const since = (mark: number) => outbound.slice(mark);
  const repliesTo = (mark: number, chatId: number | string) =>
    since(mark).filter((o) => o.chatId === chatId && o.text);

  async function message(userId: number, fields: Record<string, unknown>, chat?: Record<string, unknown>) {
    await bot.handleUpdate({
      update_id: updateId++,
      message: { message_id: msgId++, from: from(userId), chat: chat ?? privateChat(userId), date: 0, ...fields },
    } as never);
  }

  const textFields = (text: string) => ({
    text,
    ...(text.startsWith('/')
      ? { entities: [{ offset: 0, length: text.split(/[\s@]/)[0].length, type: 'bot_command' }] }
      : {}),
  });

  return {
    outbound,
    apiErrors,
    onApi,
    since,
    repliesTo,
    /** A private-chat text message (or /command) from `userId`. */
    say: (userId: number, text: string) => message(userId, textFields(text)),
    /** The same, sent in an arbitrary chat (group/supergroup tests). */
    sayIn: (chat: Record<string, unknown>, userId: number, text: string) =>
      message(userId, textFields(text), chat),
    /** A FORWARDED group text (forward_origin set): `userId` relays someone
     *  else's words — text that must never count as addressing the bot. */
    sayForwardedIn: (chat: Record<string, unknown>, userId: number, text: string) =>
      message(
        userId,
        { ...textFields(text), forward_origin: { type: 'hidden_user', sender_user_name: 'Someone', date: 0 } },
        chat,
      ),
    /** A group text replying to another member's message (reply-based room-admin commands). */
    sayInReplyTo: (chat: Record<string, unknown>, userId: number, text: string, targetId: number) =>
      message(
        userId,
        {
          ...textFields(text),
          reply_to_message: { message_id: msgId++, from: from(targetId), chat, date: 0, text: 'earlier message' },
        },
        chat,
      ),
    /** The bot's own membership changed in `chat` (added/removed) — a my_chat_member update. */
    myChatMember: (chat: Record<string, unknown>, actorId: number, oldStatus: string, newStatus: string) =>
      bot.handleUpdate({
        update_id: updateId++,
        my_chat_member: {
          chat,
          from: from(actorId),
          date: updateId,
          old_chat_member: { user: botUser, status: oldStatus },
          new_chat_member: { user: botUser, status: newStatus },
        },
      } as never),
    /** An inline-button tap on a bot card — in the user's private chat unless `chat` says otherwise.
     *  Like real Telegram, the callback carries the host message WITH its (server-attested)
     *  keyboard — by default one containing the tapped button (a legit tap). Pass `hostKeyboard`
     *  to model a FORGED callback: arbitrary `data` sent against a message whose real keyboard
     *  never offered that button (handlers that edit the host message must refuse those). */
    tap: async (
      userId: number,
      data: string,
      chat?: Record<string, unknown>,
      hostKeyboard?: Record<string, unknown>[][],
    ) => {
      await bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: String(updateId),
          from: from(userId),
          chat_instance: 'harness',
          data,
          message: {
            message_id: msgId++,
            from: { id: 999, is_bot: true, first_name: 'Demo' },
            chat: chat ?? privateChat(userId),
            date: 0,
            text: 'card',
            reply_markup: { inline_keyboard: hostKeyboard ?? [[{ text: 'card', callback_data: data }]] },
          },
        },
      } as never);
    },
    /** An inline query (@bot <query>) from any chat — the bot answers via answerInlineQuery. */
    inlineQuery: (userId: number, query: string) =>
      bot.handleUpdate({
        update_id: updateId++,
        inline_query: { id: String(updateId), from: from(userId), query, offset: '' },
      } as never),
    /** A photo message; mediaGroupId marks it as part of an album. */
    sendPhoto: (userId: number, fileId: string, opts2: { mediaGroupId?: string; caption?: string } = {}) =>
      message(userId, {
        photo: [
          { file_id: `${fileId}-small`, width: 90, height: 90 },
          { file_id: fileId, width: 800, height: 600 },
        ],
        ...(opts2.mediaGroupId ? { media_group_id: opts2.mediaGroupId } : {}),
        ...(opts2.caption ? { caption: opts2.caption } : {}),
      }),
    /** A gallery-picked video: Telegram sends msg.video (compressed), NOT msg.document. */
    sendVideo: (userId: number, fileId: string, opts2: { caption?: string } = {}) =>
      message(userId, {
        video: { file_id: fileId, width: 1280, height: 720, duration: 30 },
        ...(opts2.caption ? { caption: opts2.caption } : {}),
      }),
    /** An in-chat camera recording: a round video note (msg.video_note, never captioned). */
    sendVideoNote: (userId: number, fileId: string) =>
      message(userId, { video_note: { file_id: fileId, length: 384, duration: 15 } }),
  };
}
