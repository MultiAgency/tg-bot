import crypto from 'node:crypto';
import { config } from '../config.js';

/** The Telegram user carried inside a Mini App initData payload. */
export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface InitData {
  user: TelegramUser;
  authDate: number;
}

/**
 * Validate a Telegram Mini App `initData` string against the bot token, per the
 * Web App spec:
 *
 *   secret        = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   data_check    = every field except `hash` (the Ed25519 `signature`
 *                   INCLUDED), sorted by key, joined "key=value" with "\n"
 *   expected_hash = hex( HMAC_SHA256(key=secret, msg=data_check) )
 *
 * Throws on a missing/forged signature, or on initData older than `maxAgeSec`
 * (replay bound). The comparison is constant-time. `now` is injectable for tests.
 */
export function validateInitData(
  initData: string,
  botToken: string = config.botToken,
  // A validated initData string is a bearer credential for its user until this
  // lapses — Telegram mints a FRESH one on every Mini App open, so a tight
  // window costs no UX and shrinks how long a leaked string (a pasted localhost
  // preview URL, a request log) stays replayable.
  maxAgeSec = 3_600,
  now: number = Date.now(),
): InitData {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('initData: missing hash');
  // ONLY `hash` leaves the check string. Every other received field — including
  // `signature`, Telegram's separate Ed25519 third-party proof — is part of the
  // bot-token HMAC. Verified against live webview payloads (2026-07-13):
  // deleting `signature` too rejects every real login, while a round-trip test
  // (whose fabricated payloads carry no signature field) can't see the bug.
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('initData: signature mismatch');
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!Number.isFinite(authDate) || authDate <= 0 || now / 1000 - authDate > maxAgeSec) {
    throw new Error('initData: expired or missing auth_date');
  }

  const userRaw = params.get('user');
  if (!userRaw) throw new Error('initData: missing user');
  const user = JSON.parse(userRaw) as TelegramUser;
  if (typeof user.id !== 'number') throw new Error('initData: user has no numeric id');
  return { user, authDate };
}

/**
 * Sign a data object into a valid initData string — the exact inverse of
 * validateInitData, used only by tests to fabricate a legitimately-signed
 * payload (there is no live Telegram in the smoke suite).
 */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}
