# Bounty claim escrow (NEAR)

The on-chain half of MultiAgency payouts. **Custody model:** the treasury owner
*allocates + funds* a payout for a `(task_id, contributor NEAR account)`; the
contributor *pulls* it with `claim()` signed by their own wallet. **The bot
server holds no transfer keys and never signs** — it only records payouts
off-chain (`payouts` table); funding is a treasury action, claiming is the
contributor's.

## Live deployment (testnet)

- Contract: **`escrow.agency.testnet`** (owner: `agency.testnet`)
- Verified end-to-end 2026-07-13: `allocate` (0.5 NEAR) → `claim` moved the funds
  to the contributor and removed the allocation record (a claim deletes it, so a
  second claim finds nothing); double-claim blocked.

## Interface

| Method | Who | Notes |
|--------|-----|-------|
| `new(owner_id)` | deploy | one-time init |
| `allocate(task_id, account_id)` `#[payable]` | owner only | attached deposit **is** the amount; refuses to overwrite an unclaimed allocation |
| `claim(task_id)` | the contributor | pays `predecessor` (the signer); **removes** the allocation record — a callback restores it only if the transfer bounces |
| `revoke(task_id, account_id)` | owner only | reclaim an **unclaimed** allocation to the treasury |
| `get_allocation(task_id, account_id)` → `{amount}` \| null | anyone | presence == funded-and-unclaimed; the Mini App polls this per off-chain payout |
| `get_owner()` | anyone | |

## Build

```sh
cd contracts/escrow
cargo test                          # unit tests (logic)
cargo near build non-reproducible-wasm   # → target/near/escrow.wasm
```

## Deploy / operate (near-cli-rs)

```sh
# one-time: subaccount, funded from the treasury
near account create-account fund-myself escrow.agency.testnet '3 NEAR' \
  autogenerate-new-keypair save-to-legacy-keychain \
  sign-as agency.testnet network-config testnet sign-with-legacy-keychain send

# deploy + init
near contract deploy escrow.agency.testnet use-file target/near/escrow.wasm \
  with-init-call new json-args '{"owner_id":"agency.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send

# fund a payout (treasury; deposit = amount)
near contract call-function as-transaction escrow.agency.testnet allocate \
  json-args '{"task_id":7,"account_id":"<contributor>.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0.5 NEAR' \
  sign-as agency.testnet network-config testnet sign-with-legacy-keychain send

# claim (contributor's own wallet)
near contract call-function as-transaction escrow.agency.testnet claim \
  json-args '{"task_id":7}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as <contributor>.testnet network-config testnet sign-with-legacy-keychain send
```

## App wiring

Set in the bot env so the Mini App can query allocations and build claims:

```
NEAR_NETWORK=testnet
ESCROW_CONTRACT_ID=escrow.agency.testnet
```

Both are surfaced (public, no keys) at `GET /config`.

## App integration status

- **Wallet link — done.** NEP-413 signed challenge in the Mini App
  (`src/web/near.ts` + `/api/wallet/nonce|link`, migration 006): a verified
  `wallet_links` row maps Telegram id → NEAR account, so the treasury knows
  where to `allocate` and the Payouts screen knows which account claims.
  Covered end-to-end (real testnet key) in `web-smoke`.
- **Escrow funding — done, human-in-the-loop.** Admin `/payouts` prints the
  exact `allocate` command per owed payout (the treasury resolves the free-text
  `payouts.reward` to a yoctoNEAR deposit when running it) and reconciles each
  row's status against `get_allocation` on every run. Erasure guard: `/forget`
  refuses while a funded allocation awaits claim, so the ledger can't lose
  track of deposited NEAR.
- **Frontend claim — done, real-wallet verified.** The Payouts screen
  (`web/src/screens/Claim.tsx` + `web/src/wallet.ts`) links a wallet via
  near-connect, shows on-chain `claimable` per payout, and calls `claim()`
  through the connected wallet; the on-chain-permanence disclosure is shown at
  the linking moment. Verified two ways on 2026-07-13/14: in `web-smoke`
  (key-backed WalletConnection over the same call paths, live contract) and
  manually end-to-end with a real Meteor wallet inside the Telegram webview
  (link → treasury allocate → claim → allocation gone). Known reconciliation
  gap: a payout funded AND claimed between two `/payouts` runs is
  indistinguishable from never-funded afterwards (claims delete the on-chain
  record) — reconcile `pending → claimable` eagerly wherever an allocation is
  observed, or accept the manual sync.
