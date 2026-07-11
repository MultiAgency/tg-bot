-- 001 — initial schema (task / application / submission / history / notifications).
-- Postgres translation of the original SQLite migration 1.
--   * autoincrement PKs → BIGINT GENERATED ALWAYS AS IDENTITY
--   * every Telegram user/chat id → BIGINT (32-bit INT would overflow real ids);
--     notifications.chat_id stays TEXT (holds a numeric id OR an @username)
--   * real timestamps → TIMESTAMPTZ; tasks.deadline stays TEXT (free-form)
--   * boolean-ish flags/counters stay INTEGER

CREATE TABLE contributors (
  telegram_id     BIGINT PRIMARY KEY,
  username        TEXT,
  display_name    TEXT,
  language_code   TEXT,
  applied_count   INTEGER NOT NULL DEFAULT 0,
  assigned_count  INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  rejected_count  INTEGER NOT NULL DEFAULT 0,
  announce_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE tasks (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title           TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  reward          TEXT,
  deadline        TEXT,
  required_output TEXT,
  max_assignees   INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE applications (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id        BIGINT NOT NULL REFERENCES tasks(id),
  contributor_id BIGINT NOT NULL REFERENCES contributors(telegram_id),
  pitch          TEXT,
  status         TEXT   NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (task_id, contributor_id)
);

CREATE TABLE submissions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id BIGINT NOT NULL REFERENCES applications(id),
  version        INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  content        TEXT    NOT NULL,
  caption        TEXT,
  status         TEXT    NOT NULL,
  reviewer_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (application_id, version)
);

CREATE TABLE task_history (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id    BIGINT NOT NULL REFERENCES tasks(id),
  action     TEXT   NOT NULL,
  actor_id   BIGINT,
  subject_id BIGINT,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE notifications (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedup_key       TEXT    NOT NULL UNIQUE,
  chat_id         TEXT    NOT NULL,
  subject_id      BIGINT,
  text            TEXT,
  reply_markup    TEXT,
  media_kind      TEXT,
  media_file_id   TEXT,
  caption         TEXT,
  status          TEXT    NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_apps_task ON applications(task_id);
CREATE INDEX idx_apps_contributor ON applications(contributor_id);
CREATE INDEX idx_apps_status ON applications(status);
CREATE INDEX idx_subs_application ON submissions(application_id);
CREATE INDEX idx_subs_status ON submissions(status);
CREATE INDEX idx_history_task ON task_history(task_id);
CREATE INDEX idx_notifications_due ON notifications(status, next_attempt_at);
