# OutLayer proposer wallet — setup

The bot submits Sputnik `add_proposal` (payout Transfer) through an **OutLayer
agent custody wallet** (fastnear.com) so it never holds a fund-moving key. The
signing key lives in OutLayer's TEE; the bot holds only an API key, and a tight
policy boxes that key to "propose to the DAO." **The wallet is a DAO `Requestor`
only — never an `Approver`; payment still requires a human Approver vote.** See
`src/near/outlayer.ts`.

## One-time setup

1. **Register the wallet** (no auth needed; testnet shown):
   ```sh
   curl -s -X POST https://testnet-api.outlayer.fastnear.com/register
   # → { "api_key": "wk_…", "near_account_id": "<hex-implicit>", "handoff_url": "…" }
   ```
   Save `api_key` (shown once). `near_account_id` is the wallet's on-chain account.

2. **Make it a DAO Requestor** — an Admin proposes + approves adding the wallet's
   `near_account_id` to the `Requestor` role on `multiagency.sputnikv2.testnet`
   (`add_member_to_role`, role `Requestor`). Do NOT add it to `Approver`.

3. **Fund it for gas** — send it a little testnet NEAR (`add_proposal` costs
   ~270 TGas of gas; the bond is 0, so no deposit is attached).

4. **Set the tight policy** via the `handoff_url` dashboard (below). This is
   TEE-enforced — even a stolen API key cannot exceed it.

5. **Wire the bot**: `OUTLAYER_API_KEY=wk_…` in the bot env. `OUTLAYER_BASE_URL`
   auto-derives from `NEAR_NETWORK` (testnet → `testnet-api.outlayer.fastnear.com`).

## Tight policy (paste in the OutLayer dashboard)

Restricts a compromised API key to: only `call`, only the DAO address, ≤30/hr, no
signing primitives. It can propose (gated by the human Approver vote + your
one-click freeze) but can never transfer, vote, swap, or sign anything else.

```json
{
  "rules": {
    "transaction_types": ["call"],
    "addresses": { "mode": "whitelist", "list": ["multiagency.sputnikv2.testnet"] },
    "rate_limit": { "max_per_hour": 30 }
  },
  "capabilities": {
    "raw_sign": { "allowed": false },
    "swap": { "allowed": false },
    "cross_chain_withdraw": { "allowed": false },
    "evm_sign": { "allowed": false },
    "solana_sign": { "allowed": false },
    "sign_message": { "allowed": false }
  }
}
```

## Security boundary (what this does and does not cover)

- **Covered:** key never leaves the TEE; a stolen API key can't drain the wallet
  (call-only, deposit 0), can't call any contract but the DAO, is rate-limited, and
  can be frozen instantly.
- **NOT covered:** OutLayer's policy doesn't parse the `add_proposal` *args*, so a
  stolen key could still propose a `Transfer → attacker.near`. That proposal only
  pays out on a **human `Approver` vote** — so the approver MUST verify the on-chain
  recipient before voting. A **≥2-Approver quorum** would add a second look;
  the operator has accepted a **single-approver quorum** (decided 2026-07-21),
  which makes that one verify-before-vote check the entire human control:
  every approval must treat it as such.
