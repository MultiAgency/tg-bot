//! MultiAgency bounty claim escrow.
//!
//! Custody model (chosen deliberately): the treasury owner *allocates* a payout
//! for a (task, contributor account) by attaching the funds, and the contributor
//! *pulls* it with `claim()` signed by their own wallet. The bot server holds no
//! transfer keys and never signs — it only records payouts off-chain; funding is
//! an owner action, claiming is the contributor's. Funds live on THIS account
//! (a subaccount, e.g. escrow.agency.testnet), isolated from the treasury.
//!
//! Robustness: `claim` REMOVES the allocation before the transfer — which frees
//! its storage stake and blocks a second claim (the re-read finds nothing) — and
//! re-inserts it in a callback only if the transfer fails, so a bounced payout is
//! re-claimable rather than stuck.
//!
//! Settlement is OBSERVED, not inferred: removing an allocation writes a small
//! `Settlement` tombstone (Claimed on a successful transfer, Revoked on an owner
//! revoke), readable via `get_settlement`. Without it, an off-chain ledger can
//! only infer "claimed" from absence — which is false under revoke and gameable
//! by claiming between funding and the ledger's next read. The tombstone costs a
//! few bytes of contract-account storage per settled payout; that is the price of
//! a truthful ledger and is deliberate.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseError, PanicOnDefault};

const GAS_FOR_CLAIM_CALLBACK: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Allocation {
    /// Amount owed, in yoctoNEAR.
    pub amount: U128,
}

/// How a past allocation left the map. `get_settlement` exposes this so the
/// off-chain ledger records what actually happened instead of guessing.
#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum Settlement {
    /// The contributor pulled the funds (transfer confirmed in the callback).
    Claimed,
    /// The owner reclaimed the funds (a correction / erasure path).
    Revoked,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    /// The treasury that may allocate/revoke — the only privileged account.
    owner_id: AccountId,
    /// (task_id, account_id) -> allocation. Keyed by a composite string so a
    /// contributor's claim is scoped to exactly the task they were funded for.
    allocations: LookupMap<String, Allocation>,
    /// (task_id, account_id) -> how the last allocation on that key was settled.
    /// A re-allocate on the same key leaves the old tombstone in place until the
    /// new allocation settles and overwrites it — readers must check
    /// `get_allocation` first (presence wins over any tombstone).
    settlements: LookupMap<String, Settlement>,
}

#[near]
impl Escrow {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self { owner_id, allocations: LookupMap::new(b"a"), settlements: LookupMap::new(b"s") }
    }

    /// Fund a payout for `account_id` on `task_id`. Owner-only, and the attached
    /// deposit IS the amount. Refuses to overwrite an EXISTING allocation (a
    /// double-call would strand the first deposit) — and since a claim removes the
    /// record, "existing" always means "funded but unclaimed".
    #[payable]
    pub fn allocate(&mut self, task_id: u64, account_id: AccountId) {
        self.assert_owner();
        let amount = env::attached_deposit();
        assert!(amount > NearToken::from_yoctonear(0), "attach the payout amount as the deposit");
        let key = Self::key(task_id, &account_id);
        assert!(self.allocations.get(&key).is_none(), "an allocation for this task+account already exists");
        self.allocations.insert(key, Allocation { amount: U128(amount.as_yoctonear()) });
    }

    /// Claim the caller's allocation for `task_id` — pays the predecessor (the
    /// signer's own account), so nobody can claim on another's behalf.
    pub fn claim(&mut self, task_id: u64) -> Promise {
        let claimer = env::predecessor_account_id();
        let key = Self::key(task_id, &claimer);
        let alloc = self.allocations.get(&key).cloned().expect("no allocation for you on this task");
        assert!(alloc.amount.0 > 0, "empty allocation");

        // REMOVE the record before the async transfer: this frees its storage
        // stake (so claimed records can't accumulate unbacked and eventually wedge
        // the contract) AND blocks a second claim racing in (the re-read finds
        // nothing). The callback re-inserts it only if the transfer bounces.
        self.allocations.remove(&key);

        Promise::new(claimer)
            .transfer(NearToken::from_yoctonear(alloc.amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CLAIM_CALLBACK)
                    .on_claim_complete(key, alloc.amount),
            )
    }

    /// Callback: a confirmed transfer writes the Claimed tombstone; a bounced one
    /// restores the allocation so it is claimable again (and leaves no tombstone).
    #[private]
    pub fn on_claim_complete(&mut self, key: String, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.allocations.insert(key, Allocation { amount });
        } else {
            self.settlements.insert(key, Settlement::Claimed);
        }
    }

    /// Owner reclaims a funded-but-unclaimed allocation (a correction), returning
    /// the funds to the treasury and freeing the record. Leaves a Revoked
    /// tombstone so the ledger records "returned", never "paid".
    pub fn revoke(&mut self, task_id: u64, account_id: AccountId) -> Promise {
        self.assert_owner();
        let key = Self::key(task_id, &account_id);
        let alloc = self.allocations.get(&key).cloned().expect("no allocation");
        self.allocations.remove(&key);
        self.settlements.insert(key, Settlement::Revoked);
        Promise::new(self.owner_id.clone()).transfer(NearToken::from_yoctonear(alloc.amount.0))
    }

    // ---- views ----

    /// The allocation for a (task, account), or null. Presence == funded &
    /// unclaimed (a claim or revoke removes the record and writes a tombstone —
    /// see `get_settlement` for which).
    pub fn get_allocation(&self, task_id: u64, account_id: AccountId) -> Option<Allocation> {
        self.allocations.get(&Self::key(task_id, &account_id)).cloned()
    }

    /// How the last allocation on (task, account) was settled — "Claimed" or
    /// "Revoked" — or null if none ever settled. Check `get_allocation` first: a
    /// live allocation wins over a stale tombstone from an earlier re-allocate.
    pub fn get_settlement(&self, task_id: u64, account_id: AccountId) -> Option<Settlement> {
        self.settlements.get(&Self::key(task_id, &account_id)).cloned()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    // ---- internals ----

    fn key(task_id: u64, account_id: &AccountId) -> String {
        format!("{task_id}:{account_id}")
    }

    fn assert_owner(&self) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "owner only");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(predecessor: &str, deposit: u128) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor.parse().unwrap());
        b.attached_deposit(NearToken::from_yoctonear(deposit));
        b
    }

    #[test]
    fn allocate_then_claim_removes_the_record() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());

        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(7, "ada.testnet".parse().unwrap());
        assert_eq!(c.get_allocation(7, "ada.testnet".parse().unwrap()).unwrap().amount.0, 1_000);

        testing_env!(ctx("ada.testnet", 0).build());
        c.claim(7);
        // Claim removes the record (frees storage; presence-absence == claimed).
        assert!(c.get_allocation(7, "ada.testnet".parse().unwrap()).is_none());
    }

    #[test]
    #[should_panic(expected = "already exists")]
    fn allocate_refuses_to_overwrite() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(5, "ada.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 2_000).build());
        c.allocate(5, "ada.testnet".parse().unwrap()); // would strand the first 1_000
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_allocates() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("mallory.testnet", 1_000).build());
        c.allocate(1, "mallory.testnet".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "no allocation for you")]
    fn cannot_claim_others() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(3, "ada.testnet".parse().unwrap());
        testing_env!(ctx("mallory.testnet", 0).build());
        c.claim(3); // mallory has no allocation on task 3
    }

    #[test]
    fn confirmed_claim_writes_the_claimed_tombstone() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(7, "ada.testnet".parse().unwrap());
        testing_env!(ctx("ada.testnet", 0).build());
        c.claim(7);
        // The callback runs as the contract itself (it is #[private]).
        let mut cb = ctx("escrow.testnet", 0);
        cb.current_account_id("escrow.testnet".parse().unwrap());
        testing_env!(cb.build());
        c.on_claim_complete(Escrow::key(7, &"ada.testnet".parse().unwrap()), U128(1_000), Ok(()));
        assert!(c.get_allocation(7, "ada.testnet".parse().unwrap()).is_none());
        assert_eq!(c.get_settlement(7, "ada.testnet".parse().unwrap()), Some(Settlement::Claimed));
    }

    #[test]
    fn bounced_claim_restores_the_allocation_and_leaves_no_tombstone() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(7, "ada.testnet".parse().unwrap());
        testing_env!(ctx("ada.testnet", 0).build());
        c.claim(7);
        let mut cb = ctx("escrow.testnet", 0);
        cb.current_account_id("escrow.testnet".parse().unwrap());
        testing_env!(cb.build());
        c.on_claim_complete(Escrow::key(7, &"ada.testnet".parse().unwrap()), U128(1_000), Err(PromiseError::Failed));
        assert_eq!(c.get_allocation(7, "ada.testnet".parse().unwrap()).unwrap().amount.0, 1_000);
        assert_eq!(c.get_settlement(7, "ada.testnet".parse().unwrap()), None);
    }

    #[test]
    fn revoke_returns_funds_and_writes_the_revoked_tombstone() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(9, "ada.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 0).build());
        c.revoke(9, "ada.testnet".parse().unwrap());
        assert!(c.get_allocation(9, "ada.testnet".parse().unwrap()).is_none());
        assert_eq!(c.get_settlement(9, "ada.testnet".parse().unwrap()), Some(Settlement::Revoked));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn only_owner_revokes() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(9, "ada.testnet".parse().unwrap());
        testing_env!(ctx("mallory.testnet", 0).build());
        c.revoke(9, "ada.testnet".parse().unwrap());
    }

    #[test]
    fn reallocate_after_settlement_wins_over_the_stale_tombstone() {
        testing_env!(ctx("owner.testnet", 0).build());
        let mut c = Escrow::new("owner.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 1_000).build());
        c.allocate(4, "ada.testnet".parse().unwrap());
        testing_env!(ctx("owner.testnet", 0).build());
        c.revoke(4, "ada.testnet".parse().unwrap());
        // Fund the same (task, account) again: allocation present, old tombstone stale.
        testing_env!(ctx("owner.testnet", 2_000).build());
        c.allocate(4, "ada.testnet".parse().unwrap());
        assert_eq!(c.get_allocation(4, "ada.testnet".parse().unwrap()).unwrap().amount.0, 2_000);
        assert_eq!(c.get_settlement(4, "ada.testnet".parse().unwrap()), Some(Settlement::Revoked));
    }
}
