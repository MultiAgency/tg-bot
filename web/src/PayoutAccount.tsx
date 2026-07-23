import { useState } from 'react';
import { fetchPayoutAccount, savePayoutAccount } from './api';
import { useAsync } from './lib';

/**
 * DAO-push payout account: the contributor TYPES the NEAR account their payouts are
 * sent to — no wallet, no signature. In the push model they only receive, and each
 * sets only their own account (initData-scoped), so proof-of-control is unnecessary;
 * the server validates the account exists on-chain to catch a typo. Read-mostly:
 * one text field, no wallet connection.
 */
export function PayoutAccount() {
  const saved = useAsync(() => fetchPayoutAccount(), []);
  const [override, setOverride] = useState<string | undefined>(undefined);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const current = override ?? saved.data ?? null;
  // A failed/pending load must not masquerade as "no account set".
  const loading = override === undefined && saved.loading;
  const loadFailed = override === undefined && !!saved.error;

  const save = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setErr(null);
    setBusy(true);
    try {
      setOverride(await savePayoutAccount(v));
      setValue('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="payout-account">
      {current ? (
        <div className="payout-account-row">
          <span className="dim">payout account</span>
          <span className="mono">{current}</span>
        </div>
      ) : loadFailed ? (
        <p className="dim">Couldn’t load your payout account — reopen to retry.</p>
      ) : loading ? (
        <p className="dim">Loading…</p>
      ) : (
        <p className="dim">Set the NEAR account your payouts are sent to.</p>
      )}
      <p className="disclosure">
        When you’re paid, this account and the task id appear on the public NEAR chain, permanently — beyond erasure.
      </p>
      <input
        style={{ width: '100%', padding: '10px 12px', margin: '8px 0', boxSizing: 'border-box' }}
        placeholder={current ? 'change account, e.g. you.near' : 'you.near'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <button className="cta" disabled={busy || !value.trim()} onClick={save}>
        {busy ? 'Saving…' : current ? 'Update payout account' : 'Save payout account'}
      </button>
      {err && <div className="payout-account-err">{err}</div>}
    </div>
  );
}
