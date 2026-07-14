import { useCallback, useState } from 'react';
import { api, fetchConfig, fetchLinkedAccount } from '../api';
import { useAsync, Loading, Empty, tid } from '../lib';
import { linkWallet, claimPayout } from '../wallet';

const LABEL: Record<string, string> = {
  pending: 'awaiting escrow',
  claimable: 'ready to claim',
  claimed: 'claimed',
  revoked: 'returned to treasury',
};

/** Payouts owed for approved work. A contributor links a NEAR wallet (NEP-413),
 *  then pulls each funded payout from the claim escrow — the bot never moves
 *  funds. Server-scoped to the verified caller; `claimable` is read live on-chain. */
export function Claim() {
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((n) => n + 1), []);
  const cfg = useAsync(() => fetchConfig(), []);
  const linked = useAsync(() => fetchLinkedAccount(), [tick]);
  const payouts = useAsync(() => api.myPayouts(), [tick]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (payouts.loading || cfg.loading) return <Loading />;
  if (payouts.error) return <Empty mark="⚠" title="Couldn’t load payouts" hint={payouts.error} />;
  // A failed link check must not render the Connect CTA to an already-linked user.
  if (linked.error) return <Empty mark="⚠" title="Couldn’t check your wallet link" hint={linked.error} />;

  const list = payouts.data ?? [];
  const account = linked.data ?? null;
  const network = cfg.data?.nearNetwork ?? 'testnet';
  const escrow = cfg.data?.escrowContractId ?? '';

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(key);
    try {
      await fn();
      refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="wallet">
        {account ? (
          <div className="wallet-row">
            <span className="dim">linked wallet</span>
            <span className="mono">{account}</span>
          </div>
        ) : (
          <>
            <p className="dim">Link a NEAR wallet to claim your payouts.</p>
            <p className="disclosure">
              Claiming puts your NEAR account and task ids on the public chain, permanently — beyond erasure
              (/forget removes only the stored link, not on-chain history).
            </p>
            <button className="cta" disabled={busy === 'link'} onClick={() => run('link', () => linkWallet(network))}>
              {busy === 'link' ? 'Linking…' : 'Connect Meteor & link wallet'}
            </button>
          </>
        )}
      </div>
      {err && <div className="wallet-err">{err}</div>}

      {list.length === 0 ? (
        <Empty mark="◈" title="No payouts yet" hint="Approved work with a reward shows up here." />
      ) : (
        <div className="ledger">
          {list.map((p, i) => {
            const claiming = busy === `claim:${p.id}`;
            return (
              <div key={p.id} className="entry" style={{ animationDelay: `${Math.min(i, 12) * 40}ms`, cursor: 'default' }}>
                <div className="top">
                  <span className="id">{tid(p.taskId)}</span>
                  <span className={`chip ${p.claimable ? 'open' : p.status === 'claimed' ? 'completed' : ''}`}>
                    {p.claimable ? 'ready to claim' : LABEL[p.status] ?? p.status}
                  </span>
                </div>
                <div className="reward" style={{ fontSize: 18, margin: '8px 0' }}>◈ {p.reward}</div>
                {p.claimable && account ? (
                  <button className="cta" disabled={claiming} onClick={() => run(`claim:${p.id}`, () => claimPayout(escrow, network, p.taskId))}>
                    {claiming ? 'Claiming…' : 'Claim to your wallet →'}
                  </button>
                ) : p.claimable ? (
                  <div className="dim">Link a wallet above to claim.</div>
                ) : (
                  <div className="dim">{p.status === 'claimed' ? 'paid out' : 'awaiting on-chain funding'}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
