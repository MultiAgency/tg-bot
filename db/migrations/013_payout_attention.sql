-- 013 — persist the "look before re-proposing" flag on a payout. A DAO council
-- VOTING DOWN a Transfer proposal re-queues the payout as 'pending' (see
-- proposalToPayout — a rejection is operational: wrong amount/account), but the
-- reason evaporated with the reset: the reconcile run that performed it was the
-- only observer, so /payouts rendered the row as plain unstarted and an admin
-- would re-propose the same mistake blind. Persist it on the row; the next
-- claim (markProposed) clears it.
ALTER TABLE payouts ADD COLUMN attention BOOLEAN NOT NULL DEFAULT FALSE;
