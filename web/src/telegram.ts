// Thin, typed access to the Telegram Mini App bridge (window.Telegram.WebApp),
// loaded by telegram-web-app.js in index.html. Everything degrades gracefully
// when opened outside Telegram (a plain browser during dev): no bridge → no
// initData → the app shows an "open in Telegram" state instead of crashing.

// Only the bridge surface this app actually calls — extend it when a new
// capability gets a consumer, not before.
interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  openTelegramLink: (url: string) => void;
  HapticFeedback?: { selectionChanged: () => void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const webApp: TelegramWebApp | undefined = window.Telegram?.WebApp;

/**
 * The signed initData used to authenticate every API call. Inside Telegram it
 * comes from the bridge. A `?initData=…` query param is accepted as a fallback
 * ONLY on localhost (the local preview) — NOT a bypass: the server still
 * validates the signature against the bot token, so only a legitimately-signed
 * payload works. Gating it to localhost keeps a signed payload (a time-limited
 * credential — see auth.ts's maxAgeSec) out of any PRODUCTION URL — and therefore out of access logs and browser
 * history — where initData always arrives via the bridge, never the query string.
 */
const isLocalPreview = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
const queryInitData = isLocalPreview ? new URLSearchParams(window.location.search).get('initData') ?? '' : '';
export const initData = webApp?.initData || queryInitData;

/** Call once at startup: tell Telegram the app is ready and take the full height. */
export function initTelegram(): void {
  webApp?.ready();
  webApp?.expand();
}

/** Open a bot deep link (Apply). Inside Telegram this hands off to the chat; in a
 *  plain browser it falls back to a normal navigation. */
export function openBot(url: string): void {
  if (webApp) webApp.openTelegramLink(url);
  else window.location.href = url;
}

/** A light haptic tick on navigation, when the bridge supports it. */
export function tick(): void {
  webApp?.HapticFeedback?.selectionChanged();
}
