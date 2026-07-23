# Payouts — design direction (decided 2026-07-14)

**Decision: payouts are PUSH, settled through the Sputnik DAO — the pull-from-escrow
model has been removed.** The deciding fear was contributors failing to claim: the
webview wallet-claim tap was the flakiest surface in the product, and the manual
pass proved it (three attempts, two prompts, one signature). Under push a
contributor never touches a wallet — they type a NEAR **payout account** (validated
to exist on-chain), and money simply arrives. The DAO supplies what the custom
escrow was hand-building: council custody (no personal key), a readable receipt per
payment (the proposal), an audit trail, and FT support (a `50 USDC` reward becomes
actually payable).

## The flow

```
approve work            → payout row 'pending'              (unchanged, same txn as review)
admin taps Pay          → adopt-or-create: reuse this payout's existing proposal if one
                          exists (matched by description), else the wallet signs
                          dao.add_proposal (Transfer kind, exact policy.proposal_bond)
                        → payout row 'proposed', proposal_id pinned
council approves        → quorum reached → the DAO executes the transfer atomically
reconciler reads chain  → get_proposal(id).status →
                          Approved                     → 'paid'    (quorum hit ⇒ transfer already ran)
                          Failed                       → stay 'proposed' + ALERT (ran and bounced;
                                                         re-finalizable — NEVER 'pending', a retry double-pays)
                          Rejected | Removed           → 'pending' + loud warn (re-propose). NOT terminal:
                                                         by payout time the WORK was already approved in
                                                         review — the council sanctions only the transfer,
                                                         so a rejection is operational (mis-entered amount,
                                                         wrong account), and a terminal 'declined' would
                                                         vanish the row from /payouts with no re-open tool.
                          Expired | Moved              → 'pending'  (window lapsed / moved — re-propose)
```

Interface verified against `sputnikdao2` (2026-07-14):

- **Proposal kind** (exact): `Transfer { token_id: OldAccountId, receiver_id: AccountId, amount: U128, msg: Option<String> }`, wrapped in `ProposalInput { description, kind }`. `token_id: ""` = NEAR; an FT contract id = USDC etc.
- **Bond**: `add_proposal` is `#[payable]` and asserts the deposit **equals `policy.proposal_bond` exactly** (`ERR_MIN_BOND`) — read it live via `get_policy()`, never hardcode. Bond refunds on `Approved`/`Rejected`; it is **kept** on `Removed`.
- **Description**: `multiagency payout #<payoutId> task #<taskId>` — traceability
  without ever naming a Telegram identity (proposal text is public and permanent).
  It is also the **idempotency key** (next bullet).
- **Idempotency (adopt-or-create)**: `add_proposal` returns the id synchronously, but
  if the wallet signs and the `proposal_id` write is then lost (crash / dropped POST),
  a naive retry double-proposes → **double-pay**. Guard it: before proposing, scan
  `get_proposals(from, limit)` (bounded off `get_last_proposal_id()`) for this payout's
  description and adopt the existing id; propose only if none exists.
- **`proposal_id` on the payout row is the identity spine** — a 1:1, on-chain,
  queryable link per payout. This resolves the "payout status-inference / identity
  model" pre-mainnet blocker from the whole-code review.
- **Only `get_proposal(id).status` flips the ledger**: quorum auto-executes the
  transfer, and a bounced transfer flips `Approved`→`Failed` via the contract's
  `on_proposal_callback`. So `Approved` = executed-OK, `Failed` = executed-and-bounced
  (re-finalizable — hold, don't revert to `pending`); never read "paid" from votes.

## What the DAO model gives us

- **Contract**: Sputnik DAO v2 — already deployed, audited, ours; no custom contract to maintain.
- **Contributor action**: set a payout account once (`/payto`, or the Mini App) — no wallet signature, no claim tap.
- **Admin action**: one `/pay` — the OutLayer TEE wallet signs `add_proposal` (the bot's single proposer path; without OutLayer, `/pay` refuses — the old printed-command fallback was the root of the duplicate-proposal hazard and is gone).
- **Receipt**: the proposal itself (sender, recipient, token, amount, time).
- **Reconciler**: `get_proposal(proposal_id)` status drives the ledger.
- **Statuses**: `pending → proposed → paid` (three states, DB-enforced by a CHECK in
  migration 014). A rejected/expired/lapsed proposal returns the row to `pending` for
  re-propose (with an `attention` flag when it was voted down) — there is NO terminal
  `declined` state (deliberately — see the state table above).
- **Claim memory**: an abandoned claim (a TEE submit that reported failure and
  whose proposal never became visible within the ~10min grace) heals back to
  `pending` but KEEPS its claimed receiver+amount — a failed response doesn't
  prove the proposal didn't land. Reconcile keeps watching a healed row for
  exactly that identity (adopting a live late proposal, settling an executed one
  as `paid`), `/pay` reconciles it before ever proposing again, and `/forget`'s
  preflight chain-checks it — so a late-landing proposal can neither double-pay
  nor slip past the erasure guard. The watch is TIME-BOUNDED: a signed NEAR tx
  is only includable for ~a day (tx validity), so once a complete scan finds
  nothing past `CLAIM_MEMORY_TTL_MS` (48h, 2x the bound) the memory clears and
  the row is a plain pending row again. A reset caused by a proposal seen DEAD
  on-chain clears the memory immediately; a never-claimed `pending` row has no
  memory and costs no chain read.
- **Destination changes** (migrations 015→016): claim memory is a single slot —
  the CURRENT claim. `/pay` to a DIFFERENT identity while an earlier claim is
  unresolved is REFUSED (a bounded wait: the earlier claim either lands and is
  adopted, settles, or its memory expires at `CLAIM_MEMORY_TTL_MS`); a
  same-identity re-`/pay` proceeds. The watched superseded set migration 015
  built for this (015 created, 016 dropped) was priced for the printed-command
  era, when an old identity's proposal could land *forever* and refusing would
  dead-end indefinitely — with the bot as single proposer the wait is ≤48h, so
  the refusal replaces the whole tracking layer. **Residual:** a proposal that
  first lands in the check→commit window or after erasure is the same council
  verify-before-vote residual the current claim has always carried (an external
  submission can't be serialized against a DB lock).
- **Duplicate live proposals**: an out-of-band `add_proposal` (a council member's own wallet) landing alongside the bot's puts the SAME transfer before the council twice; the ledger pins one and the twin is invisible to every status. (The bot's own path can't mint twins: the TEE wallet is the single proposer — the old printed-command fallback that could was removed at the root.) Reconcile detects >1 live identity match (`duplicateProposals` — its own flag, not `attention`), /payouts names it so the council rejects the extra one, and /forget's paid-row audit blocks erasure while a twin of an executed transfer is still live (one vote from an unrecorded second payment).
- **Erasure guard**: /forget reconciles EVERY payout row against the chain and refuses while any is still 'proposed' (a live Transfer the council can approve, or an approved-but-failed one awaiting re-finalize) — a healed claim carrying claim memory is reconciled too, since its proposal can still land late. Fails closed on an unreadable proposal.
- **Config**: `DAO_CONTRACT_ID`, `OUTLAYER_API_KEY`, `OUTLAYER_BASE_URL`.

**Prior art to mirror**: `MultiAgency/dashboard` already runs Sputnik treasury ops in a
compatible stack (Hono + oRPC + NEAR auth, Sputnik via `daoAccountId`) — reuse its
`add_proposal` wallet-signing pattern, and treat the Mini App Payouts tab and the
dashboard's treasury view as one eventual surface. Receipts come free: an executed
proposal (`get_proposal`) IS the receipt (sender, recipient, token, amount, time) — no
receipt system to build (this is how Trezu does it).

**Escrow removed**: the custom `contracts/escrow` claim contract, its claim UI,
the NEP-413 wallet-link flow, and the `claimable`/`claimed`/`revoked` statuses
have been deleted. The DAO push rail is the only payout model — there is no
pull-custody fallback; the observability problem escrow struggled with
(claim/revoke) is solved structurally by proposals having ids and statuses.

## Build plan (one pass, fresh eyes)

1. Migration 00N: `payouts.proposal_id BIGINT NULL` + status values (`proposed`, `paid`).
   (Shipped as 009–014; the final status domain is `pending`/`proposed`/`paid` with a
   CHECK — no terminal `declined`, per the state table above.)
2. `src/near/dao.ts`: read-only `get_proposal(id)`, `get_proposals(from, limit)`,
   `get_last_proposal_id()`, `get_policy()` (for the live `proposal_bond`), plus the
   `add_proposal` FunctionCall builder (Transfer kind + exact bond) for the wallet to
   sign. Bot signs nothing, as ever. Reference shape (Trezu `nt-cli/src/payments`):
   `add_proposal` call, gas **270 TGas**, deposit = `policy.proposal_bond`, args
   `{ proposal: { description, kind: { Transfer: { token_id, receiver_id, amount, msg: null } } } }`.
3. Service: `reconcilePayoutFromProposal` replaces the allocation reconciler;
   erasure guard reconciles every payout row against the chain (see the shipped
   "Erasure guard" bullet above — the "linked account" phrasing predates the
   typed-account model).
4. **Shipped differently:** the propose action is the **bot** `/pay` command, not a
   Mini App admin button. It adopts-or-creates (validated against the pinned
   receiver + amount + native token, not just the description), then submits
   `add_proposal` via the OutLayer **TEE wallet** (the bot holds an
   add_proposal-only key — see `src/near/outlayer.ts`); without OutLayer, `/pay`
   refuses (the printed-command fallback was removed — see Duplicate live
   proposals above). The Mini App Payouts tab is read-only (shows
   pending/proposed/paid per row) and lets a contributor set their payout
   account (`POST /api/payout-account`); it has no admin Pay endpoint.
5. `/payouts` (bot) keeps parity — *shipped differently*: the admin view shows
   the queue and reconciles the shown page per run (later rows reconcile when
   they reach a page); there is no no-wallet fallback (see above).
   Non-admins get their **own** payouts view from the same command (status per
   row, contributor-toned, with a `/payto` nudge when no account is saved) —
   the bot-side twin of the Mini App tab. Approval DMs for rewarded work carry
   the same nudge, closing the "contributor never learns `/payto` exists" hole.
6. Locales, `/privacy` (disclosure wording: proposals are public + permanent,
   carry account + task id, never Telegram identity), SCOPE/README/AGENTS,
   web-smoke coverage against a testnet DAO.

## Pilot decisions (2026-07-15)

- **Transfer quorum stays 1** (decided 2026-07-21): one Approver vote executes a
  Transfer. Accepted trade-off — the single approver's verify-before-vote check
  (recipient, amount, no duplicate — /payouts flags duplicates and strays) is
  the human control on every payment; see docs/outlayer-setup.md for what the
  OutLayer boundary does and doesn't cover.

- **DAO account**: **reuse the shared MultiAgency treasury DAO** — the same treasury
  and council that govern the dashboard also govern contributor payouts (confirmed
  2026-07-15), which is the stated end-state ("one eventual surface"). No dedicated
  pilot DAO. The isolation arguments for a separate DAO are weak here: the
  adopt-by-description recovery is a recovery-only path and a freshly-submitted payout
  proposal is always newest-in-window, and the description + receiver+amount+native-token
  identity check means the bot ignores the treasury's unrelated proposals anyway (a
  shared stream is not a correctness risk at pilot volume). For the testnet pilot this
  is `multiagency.sputnikv2.testnet` (already the target of `dao-live.ts` /
  `dao-propose-live.ts`); set `DAO_CONTRACT_ID` to it.
  - **On-chain setup is DONE (verified on `multiagency.sputnikv2.testnet` 2026-07-15).**
    The OutLayer TEE wallet — implicit account
    `1e6806c76fce5398dd10f60aa688cef2fb58c44412e6e6fbd7092b435472105c` — is already a
    member of the **Requestor** role (`transfer:AddProposal` + `call:AddProposal`, no
    Vote permission — proposes only), and holds ~0.5 NEAR for gas. Nothing to change
    on-chain; only the bot env + a live dry-run remain.
- **Roles / bond / period** (the DAO's live policy, verified 2026-07-15 — two-key
  separation holds: the bot proposes, humans approve):
  - **Requestor** (proposers) = `agenticweb.testnet, agency.testnet, efiz.testnet,
    multiagency.testnet, plurality.testnet`, and the OutLayer wallet `1e68…105c`.
    Permission `transfer:AddProposal` (+ `call:AddProposal`) — no Vote.
  - **Approver** (council) = `agenticweb.testnet, agency.testnet, efiz.testnet`;
    `agency.testnet` also holds the **Admin** role (policy control).
  - **Bond = 0** — `/pay` attaches no deposit (the code reads `get_policy().proposal_bond`
    live, so this is automatic; the wallet needs only gas, which it has).
  - **Vote period = 7 days** (matches the code's `proposal_period` expiry logic).
- **FT payouts**: **pilot NEAR-only** (`token_id: ""`). The code already enforces it
  (`transferKind` hardcodes the empty token; the adopt filter refuses a non-empty one).
  USDC is a fast-follow needing recipient storage-registration — recommend the paired
  `storage_deposit` approach (check `storage_balance_of` at `/payto` set time, cover it
  then or alongside the Transfer) over Trezu's backend relay (`nt-be`); build it only
  when a real FT payout is needed.
- **Reward free text → amount**: unchanged — a human resolves `50 USDC` to an exact NEAR
  amount at `/pay` time; the council vote is the fat-finger backstop. Optional nudge:
  have `/pay` echo the snapshotted reward next to the proposed amount so the admin
  eyeballs the conversion before signing. Revisit structured rewards only if it hurts.

## Activation checklist (the rail is code-complete and dormant)

1. ✅ **DONE (2026-07-15)** — decided (reuse the shared `multiagency.sputnikv2.testnet`
   DAO; see decisions above), and its policy verified live (OutLayer wallet is a
   Requestor, bond 0, 7-day period).
2. ✅ **DONE (2026-07-15)** — `/privacy` (`privacy.text`) and SCOPE.md now disclose the
   DAO rail (proposals are public, permanent on-chain records carrying payout account +
   task id) AND OutLayer as a processor in the money path (its TEE wallet signs). Keep
   these accurate if the signing path changes.
3. ✅ **PROPOSE half DONE (2026-07-15)** — verified via `dao-propose-live.ts`: OutLayer
   TEE signed `add_proposal` (proposal #22), the ledger pinned it, reconcile read it
   `proposed`. (Note: #22 ran against a `_test` DB, so its ledger row was ephemeral and
   is gone — #22 is orphaned on-chain, harmless. Redo the propose on a PERSISTENT DB to
   close the loop.)
4. ✅ **DONE (2026-07-16)** — the `proposed → paid` loop is verified end-to-end on the live
   chain, using a persistent `DATABASE_URL` so the row survived across runs:
   `dao-propose-live` (adopted proposal #22) → `agency.testnet` VoteApprove on #22
   (transfer threshold is 1, so one vote auto-executed the 0.01 NEAR Transfer to
   `webfoundry.testnet`) → `dao-settle-live` read `#22 Approved → Executed` and flipped
   payout #1 to `paid`, enqueuing the `payout-paid:1` DM. Every transition is now proven
   against the real DAO. (Gotcha for future runs: a `_test` `DATABASE_URL` drops the row
   on process exit — use a persistent DB to settle after a vote.)
5. Set `DAO_CONTRACT_ID` (+ `OUTLAYER_API_KEY`) on prod; deploy per the AGENTS.md
   checklist; verify `/payouts` shows the pay flow and the Mini App Payouts tab shows the
   DAO states.
6. One human pass in prod: `/pay` → council vote in the DAO UI → `paid` DM actually
   arrives to a real contributor who has started the bot.
