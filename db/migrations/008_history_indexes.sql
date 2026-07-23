-- 008 — indexes for erasure's history scrub. task_history is append-only and
-- never pruned; eraseActor (models/history.ts) updates by actor_id and by
-- subject_id inside the /forget transaction, while holding the contributor's
-- application row locks. Without these, each /forget pays two sequential scans
-- of an ever-growing table mid-transaction, blocking every concurrent
-- assign/review/withdraw touching that contributor. (The third scrub — the
-- detail LIKE 'contributor N:%' pattern — is inherently a scan and stays one.)
CREATE INDEX idx_history_actor ON task_history (actor_id);
CREATE INDEX idx_history_subject ON task_history (subject_id);
