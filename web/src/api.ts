import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { AppRouter } from '../../src/web/api';
import { initData } from './telegram';

// The typed oRPC client — same AppRouter the server defines, so every call and
// its result are checked at compile time. Auth rides on every request as the
// Telegram Mini App convention header: `Authorization: tma <initData>`, which the
// Hono gate re-validates against the bot token (src/web/auth.ts).
const link = new RPCLink({
  // Absolute URL: the oRPC link constructs `new URL(url)`, which needs an origin.
  url: `${window.location.origin}/rpc`,
  headers: { Authorization: `tma ${initData}` },
});

export const api: RouterClient<AppRouter> = createORPCClient(link);

export interface AppConfig {
  botUsername: string;
  nearNetwork: string;
  escrowContractId: string;
}

let configPromise: Promise<AppConfig> | undefined;

/** Public app config (bot username for deep links + NEAR escrow coordinates for
 *  claims). Static for the session, so the fetch runs once and every later call
 *  (each TaskDetail mount, the Claim screen) shares the resolved promise. */
export function fetchConfig(): Promise<AppConfig> {
  return (configPromise ??= (async () => {
    const fallback: AppConfig = { botUsername: '', nearNetwork: 'testnet', escrowContractId: '' };
    try {
      const res = await fetch('/config');
      return res.ok ? { ...fallback, ...((await res.json()) as Partial<AppConfig>) } : fallback;
    } catch {
      return fallback;
    }
  })());
}

/** The bot's @username, for building Apply deep links. */
export async function fetchBotUsername(): Promise<string> {
  return (await fetchConfig()).botUsername;
}

/** The caller's linked NEAR account, or null when none is linked — read from the
 *  authenticated /api/me. A failed read THROWS (surfaced by useAsync as an error
 *  state) instead of masquerading as "not linked", which would show a Connect
 *  CTA to an already-linked user. */
export async function fetchLinkedAccount(): Promise<string | null> {
  const res = await fetch('/api/me', { headers: { Authorization: `tma ${initData}` } });
  if (!res.ok) throw new Error(`couldn't check your wallet link (${res.status})`);
  return ((await res.json()) as { linkedNearAccount: string | null }).linkedNearAccount;
}
