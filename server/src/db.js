// node:sqlite — встроен в Node (LTS 22.5+/24+), отдельная зависимость не
// нужна ни на разработке, ни на хостинге.
import { DatabaseSync } from "node:sqlite";

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_user_id INTEGER PRIMARY KEY,
      timezone_offset_minutes INTEGER NOT NULL DEFAULT 180,
      reminder_lead_minutes INTEGER NOT NULL DEFAULT 30,
      is_pro INTEGER NOT NULL DEFAULT 0
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

    -- Продуктовая аналитика (воронка визарда, клики по ключевым кнопкам) и
    -- клиентские ошибки (ErrorBoundary) — одна и та же таблица, отличаются
    -- только именем события ("app_error" — особый случай, см. digest.js).
    -- Свой бэкенд вместо стороннего SaaS: telegram_user_id — персональные
    -- данные по 152-ФЗ, отправлять их во внешний сервис — лишний риск и
    -- лишний вендор при масштабе в сотни пользователей.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER,
      event_name TEXT NOT NULL,
      props_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_name_time ON events (event_name, created_at);

    -- Единственная строка состояния планировщика дайджеста — когда он
    -- последний раз реально отправлялся, чтобы не задваивать/не терять
    -- период между рестартами процесса (Render на бесплатном тарифе
    -- перезапускает дыно, in-memory переменная это не пережила бы).
    CREATE TABLE IF NOT EXISTS digest_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_digest_at TEXT
    );

    -- Та же идея, для периодического бэкапа БД (см. backup.js) — единственный
    -- диск на Render не реплицируется сам по себе, а деньги за подписки
    -- в этой же базе, терять её нельзя.
    CREATE TABLE IF NOT EXISTS backup_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_backup_at TEXT
    );

    -- Снимок КАЖДОГО собранного плана (не только последнего, как в
    -- meal_slots — та таблица сознательно осталась "один активный план",
    -- она только про напоминания). plan_json — весь planView как есть:
    -- дешевле хранить как blob, чем городить нормализованную схему ради
    -- десятка записей на пользователя.
    CREATE TABLE IF NOT EXISTS plan_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      store_id TEXT NOT NULL,
      store_name TEXT NOT NULL,
      budget INTEGER NOT NULL,
      family INTEGER NOT NULL,
      total_cost INTEGER,
      plan_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plan_history_user_time ON plan_history (telegram_user_id, created_at DESC);

    -- Свободный текст, который пользователь написал боту напрямую (кнопка
    -- "Написать в поддержку" ведёт в чат с ботом, не на личный аккаунт
    -- разработчика, см. webhook.js) — админ смотрит накопленное командой
    -- /feedback, не обязан отвечать в реальном времени на каждое сообщение.
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
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

/** Время приёмов пищи раньше долетало до сервера ТОЛЬКО вместе с целым
 * планом (saveUserPlan выше) — то есть только если в текущей открытой
 * сессии есть свежесобранный план (см. useEffect в App.jsx, который зовёт
 * submitPlanToBackend). Если человек просто открыл Аккаунт поменять время
 * приёма пищи, не пересобирая план заново — новое время никогда не попадало
 * на сервер, и напоминания продолжали приходить (или не приходить) по
 * старому времени. Здесь — обновление meal_time для уже сохранённых слотов
 * НАПРЯМУЮ, без пересборки всего плана; mealTimesByType — {mealType: "HH:MM"},
 * не обязательно все 4 сразу. Если сохранённого плана ещё нет вообще —
 * просто ничего не находит и не обновляет, это не ошибка. */
export function updateMealTimesForUser(db, telegramUserId, mealTimesByType) {
  const stmt = db.prepare("UPDATE meal_slots SET meal_time = ? WHERE telegram_user_id = ? AND meal_type = ?");
  let updated = 0;
  for (const [mealType, mealTime] of Object.entries(mealTimesByType)) {
    const result = stmt.run(mealTime, telegramUserId, mealType);
    updated += result.changes;
  }
  return updated;
}

/** props сериализуются в JSON-строку прямо тут — вызывающему коду (app.js)
 * достаточно передать обычный объект, ему не нужно знать про формат хранения. */
export function insertEvent(db, { telegramUserId, eventName, props, createdAtISO }) {
  db.prepare(
    `INSERT INTO events (telegram_user_id, event_name, props_json, created_at) VALUES (?, ?, ?, ?)`
  ).run(telegramUserId ?? null, eventName, props ? JSON.stringify(props) : null, createdAtISO);
}

/** Сводка для дайджеста: сколько каких событий было с sinceISO, плюс сами
 * последние ошибки (не просто счётчик — иначе "5 app_error" ничего не
 * говорит о том, что чинить). limit на errors — сообщение в Telegram не
 * резиновое, разберём первые несколько, остальное видно по счётчику. */
export function summarizeEventsSince(db, sinceISO, { errorLimit = 5 } = {}) {
  const byName = db
    .prepare(`SELECT event_name, COUNT(*) AS count FROM events WHERE created_at >= ? GROUP BY event_name ORDER BY count DESC`)
    .all(sinceISO);
  const errors = db
    .prepare(`SELECT telegram_user_id, props_json, created_at FROM events WHERE created_at >= ? AND event_name = 'app_error' ORDER BY created_at DESC LIMIT ?`)
    .all(sinceISO, errorLimit);
  return {
    totalEvents: byName.reduce((sum, r) => sum + r.count, 0),
    byName,
    recentErrors: errors.map((e) => ({
      telegramUserId: e.telegram_user_id,
      createdAt: e.created_at,
      props: e.props_json ? JSON.parse(e.props_json) : null,
    })),
  };
}

export function getLastDigestAt(db) {
  const row = db.prepare("SELECT last_digest_at FROM digest_state WHERE id = 1").get();
  return row?.last_digest_at ?? null;
}

export function setLastDigestAt(db, isoString) {
  db.prepare(
    `INSERT INTO digest_state (id, last_digest_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_digest_at = excluded.last_digest_at`
  ).run(isoString);
}

/** true/false — реальной оплаты ещё нет (ждём ЮKassa), поэтому единственный
 * способ выставить это сейчас — server/scripts/set-pro.js вручную. Апсертим
 * пользователя, если строки ещё не было (человек может стать Pro раньше,
 * чем у него появится хоть один план/бюджет — тогда saveUserPlan ещё не
 * успел создать строку в users). */
export function setUserPro(db, telegramUserId, isPro) {
  db.prepare(
    `INSERT INTO users (telegram_user_id, is_pro) VALUES (?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET is_pro = excluded.is_pro`
  ).run(telegramUserId, isPro ? 1 : 0);
}

export function getUserPro(db, telegramUserId) {
  const row = db.prepare("SELECT is_pro FROM users WHERE telegram_user_id = ?").get(telegramUserId);
  return !!row?.is_pro;
}

/** Считаем через events, а не отдельный счётчик — событие "plan_generated"
 * и так летит с фронта на каждую успешную сборку плана (см.
 * src/lib/analytics.js), заводить вторую систему учёта ради лимита незачем.
 * Цена: если аналитика best-effort не долетела (редкий сетевой сбой),
 * лимит недосчитает — то есть скорее пропустит лишнюю бесплatную сборку,
 * чем несправедливо заблокирует настоящую. Это осознанный компромисс для
 * фичи, которая не завязана на деньги напрямую. */
export function countPlanGenerationsSince(db, telegramUserId, sinceISO) {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE telegram_user_id = ? AND event_name = 'plan_generated' AND created_at >= ?`)
    .get(telegramUserId, sinceISO);
  return row.count;
}

const PLAN_HISTORY_KEEP_PER_USER = 12;

export function savePlanHistory(db, { telegramUserId, createdAtISO, storeId, storeName, budget, family, totalCost, plan }) {
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO plan_history (telegram_user_id, created_at, store_id, store_name, budget, family, total_cost, plan_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(telegramUserId, createdAtISO, storeId, storeName, budget, family, totalCost ?? null, JSON.stringify(plan));

    // Не резиновая история — старше PLAN_HISTORY_KEEP_PER_USER записей на
    // пользователя больше никому не нужны, а blob с полным planView не
    // копеечный, чтобы хранить его бесконечно.
    db.prepare(
      `DELETE FROM plan_history WHERE telegram_user_id = ? AND id NOT IN (
         SELECT id FROM plan_history WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ?
       )`
    ).run(telegramUserId, telegramUserId, PLAN_HISTORY_KEEP_PER_USER);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listPlanHistory(db, telegramUserId, limit = PLAN_HISTORY_KEEP_PER_USER) {
  const rows = db
    .prepare(`SELECT id, created_at, store_id, store_name, budget, family, total_cost, plan_json FROM plan_history WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(telegramUserId, limit);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    storeId: r.store_id,
    storeName: r.store_name,
    budget: r.budget,
    family: r.family,
    totalCost: r.total_cost,
    plan: JSON.parse(r.plan_json),
  }));
}

export function saveFeedback(db, { telegramUserId, text, createdAtISO }) {
  db.prepare(`INSERT INTO feedback (telegram_user_id, text, created_at) VALUES (?, ?, ?)`).run(telegramUserId, text, createdAtISO);
}

export function listRecentFeedback(db, limit = 10) {
  const rows = db.prepare(`SELECT telegram_user_id, text, created_at FROM feedback ORDER BY created_at DESC LIMIT ?`).all(limit);
  return rows.map((r) => ({ telegramUserId: r.telegram_user_id, text: r.text, createdAt: r.created_at }));
}

export function getLastBackupAt(db) {
  const row = db.prepare("SELECT last_backup_at FROM backup_state WHERE id = 1").get();
  return row?.last_backup_at ?? null;
}

export function setLastBackupAt(db, isoString) {
  db.prepare(
    `INSERT INTO backup_state (id, last_backup_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_backup_at = excluded.last_backup_at`
  ).run(isoString);
}
