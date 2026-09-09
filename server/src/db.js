// node:sqlite — встроен в Node (LTS 22.5+/24+), отдельная зависимость не
// нужна ни на разработке, ни на хостинге. Одна БД-файл, один активный план
// на пользователя (история планов — сознательно не в этой итерации, см.
// docs/telegram-bot-architecture.md в корне репозитория).
import { DatabaseSync } from "node:sqlite";

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_user_id INTEGER PRIMARY KEY,
      timezone_offset_minutes INTEGER NOT NULL DEFAULT 180,
      reminder_lead_minutes INTEGER NOT NULL DEFAULT 30
    );
    CREATE TABLE IF NOT EXISTS meal_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      scheduled_date TEXT NOT NULL,
      meal_type TEXT NOT NULL,
      meal_label TEXT NOT NULL,
      meal_time TEXT NOT NULL,
      recipe_name TEXT NOT NULL,
      reminder_sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meal_slots_due
      ON meal_slots (scheduled_date, reminder_sent_at);
  `);
  return db;
}

// Один активный план на пользователя: сохранение плана целиком заменяет
// предыдущий (DELETE + INSERT в одной транзакции) — проще и надёжнее
// частичного апдейта, раз истории планов пока нет.
export function saveUserPlan(db, { telegramUserId, timezoneOffsetMinutes, reminderLeadMinutes, mealSlots }) {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO users (telegram_user_id, timezone_offset_minutes, reminder_lead_minutes)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET
         timezone_offset_minutes = excluded.timezone_offset_minutes,
         reminder_lead_minutes = excluded.reminder_lead_minutes`
    ).run(telegramUserId, timezoneOffsetMinutes, reminderLeadMinutes);

    db.prepare("DELETE FROM meal_slots WHERE telegram_user_id = ?").run(telegramUserId);

    const insert = db.prepare(
      `INSERT INTO meal_slots (telegram_user_id, scheduled_date, meal_type, meal_label, meal_time, recipe_name)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const slot of mealSlots) {
      insert.run(telegramUserId, slot.scheduledDate, slot.mealType, slot.mealLabel, slot.mealTime, slot.recipeName);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Кандидаты на напоминание "прямо сейчас" — сегодняшние (по UTC-дате
 * достаточно грубо, точная проверка окна — в reminderTiming.js) слоты, ещё
 * не отправленные, с настройками пользователя присоединёнными сразу через
 * JOIN — сама точная арифметика времени/часового пояса делается в чистой
 * функции reminderTiming.findDueReminders(), не в SQL. */
export function findCandidateSlots(db, todayISO, tomorrowISO) {
  return db
    .prepare(
      `SELECT ms.id, ms.telegram_user_id, ms.scheduled_date, ms.meal_type, ms.meal_label, ms.meal_time, ms.recipe_name,
              u.timezone_offset_minutes, u.reminder_lead_minutes
       FROM meal_slots ms
       JOIN users u ON u.telegram_user_id = ms.telegram_user_id
       WHERE ms.reminder_sent_at IS NULL
         AND ms.scheduled_date IN (?, ?)`
    )
    .all(todayISO, tomorrowISO);
}

export function markReminderSent(db, slotId, sentAtISO) {
  db.prepare("UPDATE meal_slots SET reminder_sent_at = ? WHERE id = ?").run(sentAtISO, slotId);
}
