# Payouts — design direction (decided 2026-07-14)

**Decision: payouts are PUSH, settled through the Sputnik DAO — not pull-from-escrow.**
The deciding fear was contributors failing to claim: the webview wallet-claim tap
is the flakiest surface in the product, and the manual pass proved it (three
attempts, two prompts, one signature). Under push, a contributor's lifetime
wallet interaction count is **one** — the NEP-413 link — and money simply
arrives. The DAO supplies what the custom escrow was hand-building: treasury
custody (no personal key), a readable receipt per payment (the proposal), an
audit trail, and FT support (a `50 USDC` reward becomes actually payable).

## The flow

```
approve work            → payout row 'pending'         (unchanged, same txn as review)
admin taps Pay          → wallet signs dao.add_proposal (Transfer kind, bond attached)
                        → payout row 'proposed', proposal_id pinned
council approves        → the DAO executes the transfer — approval IS the payment
reconciler reads chain  → get_proposal(id): Approved/Executed → 'paid'
                          Rejected | Expired | Failed        → back to 'pending' (loudly)
```

- **Proposal kind**: `Transfer { token_id: "" (NEAR) | <ft contract>, receiver_id: <linked account>, amount }`.
- **Description**: `multiagency payout #<payoutId> task #<taskId>` — traceability
  without ever naming a Telegram identity (proposal text is public and permanent).
- **`proposal_id` on the payout row is the identity spine** — a 1:1, on-chain,
  queryable link that replaces the `(task_id, account_id)` presence-inference of
  the escrow model. This resolves the "payout status-inference / identity model"
  pre-mainnet blocker from the whole-code review.
- **Never infer 'paid' from the vote**: an approved proposal's execution can still
  fail (insufficient treasury balance → Sputnik status `Failed`). Only the final
  proposal status flips the ledger.

## What this changes

| Piece | Before (escrow pull) | After (DAO push) |
|---|---|---|
| Contract | custom `contracts/escrow` (allocate/claim/revoke) | Sputnik DAO v2 (already deployed, audited, ours) |
| Contributor action | link wallet + claim tap | link wallet only |
| Admin action | copy CLI allocate command | one Pay tap (wallet signs `add_proposal`) |
| Receipt | allocation presence / tombstones | the proposal itself |
| Reconciler | `get_allocation` inference | `get_proposal(proposal_id)` status |
| Statuses | pending/claimable/claimed/revoked | pending/proposed/paid/declined |
| Erasure guard | chain-read for funded allocations | refuse while an InProgress proposal names the linked account |
| Config | `ESCROW_CONTRACT_ID` | `DAO_CONTRACT_ID` (escrow vars retired from the active path) |

**Parked, not deleted**: `contracts/escrow` and the claim UI stay in the tree as
the future pull-custody option. The in-flight tombstone/account-pinning work on
the escrow model should pause — its problem (claim/revoke observability) is
solved structurally by proposals having ids and statuses.

## Build plan (one pass, fresh eyes)

1. Migration 00N: `payouts.proposal_id BIGINT NULL` + status values
   (`proposed`, `paid`, `declined`); map existing rows (claimed→paid, revoked→declined).
2. `src/near/dao.ts`: read-only `get_proposal` + the `add_proposal` FunctionCall
   builder (args + bond) for the wallet to sign. Bot signs nothing, as ever.
3. Service: `reconcilePayoutFromProposal` replaces the allocation reconciler;
   erasure guard reads open proposals for the linked account.
4. Mini App: admin-gated **Pay** action on the Payouts queue (server gates by
   `ADMIN_IDS` via initData — never expose the admin list in /config); wallet
   signs the proposal; screen shows proposed/paid/declined per row. Claim button
   and `claimable` plumbing retire with the escrow path.
5. `/payouts` (bot) keeps parity: shows the queue, prints the `add_proposal`
   CLI command as the no-wallet fallback, reconciles on every run.
6. Locales, `/privacy` (disclosure wording: proposals are public + permanent,
   carry account + task id, never Telegram identity), SCOPE/README/AGENTS,
   web-smoke coverage against a testnet DAO.

## Open questions (answer before building)

- **Which DAO account** (mainnet DAO exists; pilot should run against a testnet
  Sputnik instance — create one, or reuse an existing test DAO?).
- **Council shape for the pilot**: with a one-member council, propose+approve is
  a single flow; confirm the bond amount and vote policy on the actual DAO.
- **FT payouts**: receiving USDC requires the contributor's account to be
  storage-registered with the token contract — decide whether the Pay flow
  checks/covers `storage_deposit` or NEAR-only for the pilot.
- **Reward free text → amount**: unchanged — a human resolves `50 USDC` to an
  exact amount at propose time. Revisit structured rewards only if it hurts.
