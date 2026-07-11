-- 002 — rooms (group chats the bot was added to), room-scoped admins, and signal
-- detection. Signals store NO message text and NO author id: /privacy promises that
-- people who only chat in a group with the bot are never recorded; a signal row exists
-- only to enforce the per-room hourly AI budget and link the drafted task.
-- tasks.room_chat_id is provenance + the room-admin authorization scope
-- (NULL = a task created via DM, manageable by global admins only).

CREATE TABLE rooms (
  chat_id         BIGINT PRIMARY KEY,
  title           TEXT,
  signals_enabled INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE room_admins (
  room_chat_id BIGINT NOT NULL REFERENCES rooms(chat_id),
  telegram_id  BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (room_chat_id, telegram_id)
);

CREATE TABLE signals (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_chat_id BIGINT NOT NULL REFERENCES rooms(chat_id),
  score        DOUBLE PRECISION,
  status       TEXT NOT NULL,
  task_id      BIGINT REFERENCES tasks(id),
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

ALTER TABLE tasks ADD COLUMN room_chat_id BIGINT REFERENCES rooms(chat_id);

CREATE INDEX idx_room_admins_member ON room_admins(telegram_id);
CREATE INDEX idx_signals_room_created ON signals(room_chat_id, created_at);
CREATE INDEX idx_tasks_room ON tasks(room_chat_id);
