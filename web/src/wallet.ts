import { Near, fromNearConnect, type WalletConnection } from 'near-kit';
import { initData } from './telegram';

/**
 * NEAR wallet for the Mini App. Two operations sit on a near-kit WalletConnection:
 *   - linkWallet(): NEP-413-sign the server's challenge and record the account.
 *   - claimPayout(): a `claim()` call on the escrow, signed by the wallet.
 *
 * The concrete connector (near-connect, targeting Meteor) is isolated in
 * getWallet() and dynamically imported, so the connector — the one piece that
 * needs a real wallet to verify — can't break the rest of the bundle, and tests
 * inject a key-backed WalletConnection via useConnection() to exercise the same
 * link/claim paths against the live contract without a wallet UI.
 *
 * Session model (learned the hard way in the 2026-07-13 webview pass):
 *   - ONE NearConnector per page load, `whenManifestLoaded` awaited before any
 *     connect — calling connect() earlier finds no wallets and throws, which
 *     surfaces as a bogus "Action was cancelled" on the first-ever tap.
 *   - The connector PERSISTS its session; `connector.wallet()` (which near-kit's
 *     adapter calls per operation) restores it silently. So getWallet() probes
 *     for an existing session first and only opens the interactive modal when
 *     there is none — otherwise every page load costs a pointless extra wallet
 *     round-trip before the real signature (the "Meteor asked twice" bug).
 */

interface ConnectorLike {
  whenManifestLoaded: Promise<unknown>;
  connect: () => Promise<unknown>;
}

let injected: { conn: WalletConnection; account: string } | null = null;
let bundle: Promise<{ connector: ConnectorLike; conn: WalletConnection }> | null = null;

/** Inject a WalletConnection (tests: a key-backed one bypassing the connector). */
export function useConnection(connection: WalletConnection, accountId: string): void {
  injected = { conn: connection, account: accountId };
}

function getConnector(network: string): Promise<{ connector: ConnectorLike; conn: WalletConnection }> {
  if (!bundle) {
    bundle = (async () => {
      const { NearConnector } = await import('@hot-labs/near-connect');
      const connector = new NearConnector({ network: network as 'testnet' | 'mainnet' });
      await connector.whenManifestLoaded;
      return { connector, conn: fromNearConnect(connector) };
    })();
  }
  return bundle;
}

/** The connected wallet: a silently-restored session when one persists, the
 *  interactive near-connect modal only when none does. */
export async function getWallet(network: string): Promise<{ conn: WalletConnection; account: string }> {
  if (injected) return injected;
  const { connector, conn } = await getConnector(network);
  try {
    const accounts = await conn.getAccounts(); // restores a persisted session, no UI
    if (accounts[0]) return { conn, account: accounts[0].accountId };
  } catch {
    // No persisted session — fall through to the interactive modal.
  }
  await connector.connect();
  const accounts = await conn.getAccounts();
  const account = accounts[0]?.accountId;
  if (!account) throw new Error('No account connected');
  return { conn, account };
}

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `tma ${initData}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) ?? `request failed (${res.status})`);
  return json;
}

/** Prove control of the connected NEAR account (NEP-413) and record the link. */
export async function linkWallet(network: string): Promise<string> {
  const { conn } = await getWallet(network);
  if (!conn.signMessage) throw new Error('This wallet does not support message signing (NEP-413).');
  const challenge = (await api('/api/wallet/nonce')) as { nonce: string; message: string; recipient: string };
  const signed = await conn.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: Uint8Array.from(atob(challenge.nonce), (ch) => ch.charCodeAt(0)),
  });
  await api('/api/wallet/link', {
    accountId: signed.accountId,
    publicKey: signed.publicKey,
    signature: signed.signature,
    nonce: challenge.nonce,
  });
  return signed.accountId;
}

/** Claim a funded payout — a `claim(task_id)` call on the escrow, signed by the wallet. */
export async function claimPayout(escrowId: string, network: string, taskId: number): Promise<void> {
  const { conn } = await getWallet(network);
  const near = new Near({ network: network as 'testnet' | 'mainnet', wallet: conn });
  await near.call(escrowId, 'claim', { task_id: taskId });
}
