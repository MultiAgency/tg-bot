import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Three entities:
 *   task        — a unit of work (a container). Draft → Open → Closed.
 *   application — a contributor's expression of interest + selection. Applied → Assigned/Declined/Withdrawn.
 *   submission  — the work delivered by an assigned contributor, versioned. Submitted → NeedsRevision/Approved/Rejected.
 * One task has many applications; one (assigned) application has many submission versions.
 * task_history is a per-task audit log spanning all three.
 *
 * Schema changes are sequential migrations tracked in PRAGMA user_version:
 * append a new SQL string to MIGRATIONS (never edit an applied one — deployed
 * databases have already run it) and it applies exactly once, transactionally,
 * at startup.
 */
const MIGRATIONS: string[] = [
  // 1 — initial schema. IF NOT EXISTS keeps this a no-op on databases created
  //     before user_version tracking existed (the pilot database).
  `
  CREATE TABLE IF NOT EXISTS contributors (
    telegram_id     INTEGER PRIMARY KEY,
    username        TEXT,
    display_name    TEXT,
    language_code   TEXT,
    applied_count   INTEGER NOT NULL DEFAULT 0,
    assigned_count  INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    rejected_count  INTEGER NOT NULL DEFAULT 0,
    announce_opt_in INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL DEFAULT '',
    reward          TEXT,
    deadline        TEXT,
    required_output TEXT,
    max_assignees   INTEGER NOT NULL DEFAULT 1,
    status          TEXT    NOT NULL,
    created_by      INTEGER,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applications (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id        INTEGER NOT NULL REFERENCES tasks(id),
    contributor_id INTEGER NOT NULL REFERENCES contributors(telegram_id),
    pitch          TEXT,
    status         TEXT    NOT NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    UNIQUE (task_id, contributor_id)
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id),
    version        INTEGER NOT NULL,
    type           TEXT    NOT NULL,
    content        TEXT    NOT NULL,
    caption        TEXT,
    status         TEXT    NOT NULL,
    reviewer_note  TEXT,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    UNIQUE (application_id, version)
  );

  CREATE TABLE IF NOT EXISTS task_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id),
    action     TEXT    NOT NULL,
    actor_id   INTEGER,
    subject_id INTEGER,
    detail     TEXT,
    created_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key       TEXT    NOT NULL UNIQUE,
    chat_id         TEXT    NOT NULL,
    subject_id      INTEGER,
    text            TEXT,
    reply_markup    TEXT,
    media_kind      TEXT,
    media_file_id   TEXT,
    caption         TEXT,
    status          TEXT    NOT NULL DEFAULT 'queued',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT    NOT NULL,
    last_error      TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_apps_task ON applications(task_id);
  CREATE INDEX IF NOT EXISTS idx_apps_contributor ON applications(contributor_id);
  CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
  CREATE INDEX IF NOT EXISTS idx_subs_application ON submissions(application_id);
  CREATE INDEX IF NOT EXISTS idx_subs_status ON submissions(status);
  CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(status, next_attempt_at);
`,
];

{
  const applied = db.pragma('user_version', { simple: true }) as number;
  for (let v = applied; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Online snapshot of the live database (safe under WAL, non-blocking), one
 * file per weekday overwritten weekly. The 7-day rotation is a privacy
 * property, not just a disk cap: erased contributors age out of backups
 * within a week (stated in /privacy). Guards against corruption and botched
 * migrations; volume loss is Railway volume backups' job, not this.
 */
export function backupDb(): Promise<string> {
  const target = `${config.databasePath}.backup-${WEEKDAYS[new Date().getDay()]}`;
  return db.backup(target).then(() => target);
}
