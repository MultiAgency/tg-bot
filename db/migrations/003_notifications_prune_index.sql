-- 003 — index the retention prune. pruneFinished() deletes rows matching
-- (status IN ('sent','failed') AND updated_at < cutoff); the only prior index,
-- idx_notifications_due(status, next_attempt_at), doesn't cover updated_at, so
-- the daily prune (and the startup prune) was a sequential scan. This makes it a
-- range scan on the finished rows. Partial: queued rows are never pruned, so the
-- index stays small and doesn't compete with the delivery-path index above.

CREATE INDEX idx_notifications_prune ON notifications(status, updated_at)
  WHERE status IN ('sent', 'failed');
