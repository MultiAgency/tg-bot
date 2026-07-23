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
  daoContractId: string;
}

let configPromise: Promise<AppConfig> | undefined;

/** Public app config (bot username for deep links + the DAO contract id the
 *  Payouts screen keys off). Static for the session, so one SUCCESSFUL fetch is
 *  shared by every later call (each TaskDetail mount, the Payouts screen). A
 *  failure — e.g. opening the app during a deploy's few seconds of downtime —
 *  returns the fallback but clears the memo, so the next mount retries instead
 *  of hiding the payout-account UI for the rest of the session. */
export function fetchConfig(): Promise<AppConfig> {
  return (configPromise ??= (async () => {
    const fallback: AppConfig = { botUsername: '', daoContractId: '' };
    try {
      // Bounded: a server that accepts and hangs (mid-deploy LB) would otherwise
      // pin the memo on a never-settling promise, beyond the clear-on-failure.
      const res = await fetch('/config', { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return { ...fallback, ...((await res.json()) as Partial<AppConfig>) };
    } catch {
      // fall through to the retry-able fallback
    }
    configPromise = undefined;
    return fallback;
  })());
}

/** The bot's @username, for building Apply deep links. */
export async function fetchBotUsername(): Promise<string> {
  return (await fetchConfig()).botUsername;
}

/** The caller's saved DAO-push payout account (typed, existence-checked), or null. */
export async function fetchPayoutAccount(): Promise<string | null> {
  const res = await fetch('/api/me', { headers: { Authorization: `tma ${initData}` } });
  if (!res.ok) throw new Error(`couldn't load your payout account (${res.status})`);
  return ((await res.json()) as { payoutAccount: string | null }).payoutAccount;
}

/** Save the caller's DAO-push payout account. The server validates it exists
 *  on-chain (typed accounts carry no proof); a 400 carries a user-safe message. */
export async function savePayoutAccount(account: string): Promise<string> {
  const res = await fetch('/api/payout-account', {
    method: 'POST',
    headers: { Authorization: `tma ${initData}`, 'content-type': 'application/json' },
    body: JSON.stringify({ account }),
  });
  const json = (await res.json().catch(() => ({}))) as { payoutAccount?: string; error?: string };
  if (!res.ok || !json.payoutAccount) throw new Error(json.error ?? `couldn't save your payout account (${res.status})`);
  return json.payoutAccount;
}
