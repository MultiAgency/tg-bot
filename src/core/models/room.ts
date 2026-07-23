import { one, many, run, nowIso } from '../db.js';

/**
 * A room is a group chat the bot was added to. It carries the per-group signal
 * toggle and scopes room admins: contributors who may manage the tasks that
 * belong to that room (tasks.room_chat_id) without being global admins.
 * Room rows are keyed by the Telegram chat id and never deleted — when the bot
 * leaves a group, signals are switched off and the row stays as provenance for
 * the tasks it produced.
 */

export interface Room {
  chat_id: number;
  title: string | null;
  signals_enabled: 0 | 1;
  ai_enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

/** Create the room, or refresh its title (Telegram titles change). */
export async function upsertRoom(chatId: number, title: string | null): Promise<Room> {
  return (await one<Room>(
    `INSERT INTO rooms (chat_id, title, signals_enabled, created_at, updated_at)
     VALUES ($1, $2, 0, $3, $3)
     ON CONFLICT (chat_id) DO UPDATE SET
       title = COALESCE(EXCLUDED.title, rooms.title),
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [chatId, title, nowIso()],
  ))!;
}

export async function getRoom(chatId: number): Promise<Room | undefined> {
  return one<Room>('SELECT * FROM rooms WHERE chat_id = $1', [chatId]);
}

/**
 * Fetch a room with a row lock (SELECT … FOR UPDATE). Must be called inside a
 * transaction: it serializes concurrent signal-budget claims for the same room
 * (claimSignalSlot), so two group messages can't both pass the hourly check.
 */
export async function getRoomForUpdate(chatId: number): Promise<Room | undefined> {
  return one<Room>('SELECT * FROM rooms WHERE chat_id = $1 FOR UPDATE', [chatId]);
}

export async function setSignalsEnabled(chatId: number, enabled: boolean): Promise<Room> {
  return (await one<Room>(
    'UPDATE rooms SET signals_enabled = $1, updated_at = $2 WHERE chat_id = $3 RETURNING *',
    [enabled ? 1 : 0, nowIso(), chatId],
  ))!;
}

export async function setAiEnabled(chatId: number, enabled: boolean): Promise<Room> {
  return (await one<Room>(
    'UPDATE rooms SET ai_enabled = $1, updated_at = $2 WHERE chat_id = $3 RETURNING *',
    [enabled ? 1 : 0, nowIso(), chatId],
  ))!;
}

// ---- group → supergroup migration (service.migrateRoomChat orchestrates) ----
// rooms.chat_id is the FK target of room_admins, signals, and tasks, none of
// which cascade on update — so a chat-id change is copy-parent → move-children
// → drop-old, all inside the caller's transaction.

/** Copy the room row to its successor chat id (merge if the successor row
 *  already exists — the OLD row carries the real opt-ins, so its flags win). */
export async function copyRoomTo(oldChatId: number, newChatId: number): Promise<void> {
  await run(
    `INSERT INTO rooms (chat_id, title, signals_enabled, ai_enabled, created_at, updated_at)
     SELECT $1, title, signals_enabled, ai_enabled, created_at, $3 FROM rooms WHERE chat_id = $2
     ON CONFLICT (chat_id) DO UPDATE SET
       title = COALESCE(EXCLUDED.title, rooms.title),
       signals_enabled = EXCLUDED.signals_enabled,
       ai_enabled = EXCLUDED.ai_enabled,
       updated_at = EXCLUDED.updated_at`,
    [newChatId, oldChatId, nowIso()],
  );
}

/** Re-point the old room's admins at the successor id (dropping any that the
 *  successor somehow already has, so the composite PK can't collide). */
export async function moveAdmins(oldChatId: number, newChatId: number): Promise<void> {
  await run(
    `DELETE FROM room_admins WHERE room_chat_id = $1
       AND telegram_id IN (SELECT telegram_id FROM room_admins WHERE room_chat_id = $2)`,
    [oldChatId, newChatId],
  );
  await run('UPDATE room_admins SET room_chat_id = $1 WHERE room_chat_id = $2', [newChatId, oldChatId]);
}

/** Drop the retired room row — callable only once its children have moved. */
export async function dropRoom(chatId: number): Promise<void> {
  await run('DELETE FROM rooms WHERE chat_id = $1', [chatId]);
}

// ---- room admins ----

/** Idempotent: returns true if the admin was newly added, false if already one. */
export async function addAdmin(roomChatId: number, telegramId: number): Promise<boolean> {
  return (
    (await run(
      `INSERT INTO room_admins (room_chat_id, telegram_id, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_chat_id, telegram_id) DO NOTHING`,
      [roomChatId, telegramId, nowIso()],
    )) > 0
  );
}

/** Returns true if a row was removed. */
export async function removeAdmin(roomChatId: number, telegramId: number): Promise<boolean> {
  return (await run('DELETE FROM room_admins WHERE room_chat_id = $1 AND telegram_id = $2', [roomChatId, telegramId])) > 0;
}

export async function isAdmin(roomChatId: number, telegramId: number): Promise<boolean> {
  return (await one('SELECT 1 AS ok FROM room_admins WHERE room_chat_id = $1 AND telegram_id = $2', [roomChatId, telegramId])) !== undefined;
}

export async function listAdmins(roomChatId: number): Promise<number[]> {
  return (
    await many<{ telegram_id: number }>(
      'SELECT telegram_id FROM room_admins WHERE room_chat_id = $1 ORDER BY created_at ASC, telegram_id ASC',
      [roomChatId],
    )
  ).map((r) => r.telegram_id);
}

/** Every room chat id this user administers (empty for non-room-admins). */
export async function roomChatIdsForAdmin(telegramId: number): Promise<number[]> {
  return (
    await many<{ room_chat_id: number }>('SELECT room_chat_id FROM room_admins WHERE telegram_id = $1 ORDER BY room_chat_id ASC', [
      telegramId,
    ])
  ).map((r) => r.room_chat_id);
}

/** Used by erasure: drop the contributor's room-admin memberships (their id is PII). */
export async function deleteAdminEverywhere(telegramId: number): Promise<number> {
  return run('DELETE FROM room_admins WHERE telegram_id = $1', [telegramId]);
}
