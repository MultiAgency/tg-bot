import { api, fetchConfig } from '../api';
import { useAsync, Loading, Empty, tid } from '../lib';
import { PayoutAccount } from '../PayoutAccount';

// Per DAO payout state: the chip label and the quiet line under the row (the
// hint is omitted where it would just repeat the chip). `attentionHint`
// replaces the hint when the row needs a human (rejected vote, failed transfer).
const STATUS: Record<'pending' | 'proposed' | 'paid', { label: string; hint?: string; attentionHint?: string }> = {
  pending: { label: 'awaiting payment', attentionHint: 'the last payment proposal wasn’t approved — an admin will re-propose' },
  proposed: {
    label: 'payment proposed',
    hint: 'payment proposed — awaiting DAO approval',
    attentionHint: 'the payment needs an admin’s attention',
  },
  paid: { label: 'paid', hint: 'paid to your account 🎉' },
};

/** Payouts owed for approved work. The contributor sets a NEAR payout account
 *  (typed, no wallet); the DAO council approves each Transfer — the bot never
 *  moves funds. Server-scoped to the verified caller. */
export function Payouts() {
  const cfg = useAsync(() => fetchConfig(), []);
  const payouts = useAsync(() => api.myPayouts(), []);

  if (payouts.loading || cfg.loading) return <Loading />;
  if (payouts.error) return <Empty mark="⚠" title="Couldn’t load payouts" hint={payouts.error} />;

  const list = payouts.data ?? [];
  const dao = cfg.data?.daoContractId ?? '';

  return (
    <>
      {dao && <PayoutAccount />}

      {list.length === 0 ? (
        <Empty mark="◈" title="No payouts yet" hint="Approved work with a reward shows up here." />
      ) : (
        <div className="ledger">
          {list.map((p, i) => (
            <div key={p.id} className="entry" style={{ animationDelay: `${Math.min(i, 12) * 40}ms`, cursor: 'default' }}>
              <div className="top">
                <span className="id">{tid(p.taskId)}</span>
                <span className={`chip ${p.status === 'paid' ? 'completed' : ''}`}>{STATUS[p.status].label}</span>
              </div>
              {/* Once proposed/paid, show the exact pinned on-chain amount — the
                  free-text reward (e.g. "500 USDC") can contradict what was sent. */}
              <div className="reward" style={{ fontSize: 18, margin: '8px 0' }}>
                ◈ {p.amountNear ? `${p.amountNear} NEAR` : p.reward}
              </div>
              {(() => {
                // An unverified row must not read as authoritative: `status` is
                // then the stored snapshot, not chain truth — same honesty the
                // bot's /payouts keeps with its held/couldn't-check lines.
                if (!p.ok) {
                  return (
                    <div className="dim">
                      {p.held
                        ? 'payment proposal in flight — check back shortly'
                        : 'couldn’t check the payment’s on-chain status just now — reload to retry'}
                    </div>
                  );
                }
                const s = STATUS[p.status];
                const hint = (p.attention && s.attentionHint) || s.hint;
                return hint ? <div className="dim">{hint}</div> : null;
              })()}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
