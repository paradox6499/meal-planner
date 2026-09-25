// node:sqlite — встроен в Node (LTS 22.5+/24+), отдельная зависимость не
// нужна ни на разработке, ни на хостинге.
import { DatabaseSync } from "node:sqlite";

// ALTER TABLE ... ADD COLUMN IF NOT EXISTS не поддержан версией SQLite,
// встроенной в node:sqlite (проверено вживую — синтаксическая ошибка) —
// добавляем колонку в УЖЕ существующую (задеплоенную, с реальными данными)
// таблицу users только если её там ещё нет. CREATE TABLE IF NOT EXISTS ниже
// эту задачу не решает: он не трогает таблицу, которая уже была создана
// раньше по старой схеме.
function ensureColumn(db, table, column, definitionSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definitionSql}`);
}

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

    -- Общий кэш цен ВкусВилл по названию ингредиента, ОДИН на всех
    -- пользователей — раньше каждая сборка плана заново спрашивала цену
    -- каждого ингредиента у ВкусВилл живьём (см. src/lib/vkusvillMcp.js:
    -- resolvePrices — у него есть кэш, но in-memory и per-браузер, ничего не
    -- переживает и ни с кем не делится). Реальные названия сильно
    -- пересекаются между разными пользователями (курица, лук, молоко — почти
    -- в каждом плане) — общий кэш на сервере должен заметно снизить число
    -- живых запросов к ВкусВилл и, соответственно, как часто вообще упираемся
    -- в их rate-limit (см. vkusvillPrices.js). matched=0 кэшируется тоже
    -- (короче TTL, см. INGREDIENT_PRICE_TTL_MS в vkusvillPrices.js) — чтобы
    -- не переспрашивать про заведомо не находящиеся позиции ("специи" и т.п.)
    -- на каждый чих.
    CREATE TABLE IF NOT EXISTS ingredient_prices (
      name TEXT PRIMARY KEY,
      matched INTEGER NOT NULL,
      price REAL,
      product_unit TEXT,
      xml_id TEXT,
      updated_at TEXT NOT NULL
    );

    -- Каждый платёж ЮKassa (см. yookassa.js) — не только последний статус
    -- пользователя, а вся история: нужна и для "раз в день отчёт о купленных
    -- подписках" (см. digest.js:summarizePaymentsSince), и на случай спора
    -- по возврату (см. terms.html: "24 часа с момента оплаты").
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      yookassa_payment_id TEXT NOT NULL UNIQUE,
      telegram_user_id INTEGER NOT NULL,
      amount_rub REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payments_created ON payments (created_at DESC);

    -- Кто кого пригласил (см. referrals.js) — referred_telegram_id UNIQUE:
    -- у одного приглашённого может быть только ОДИН пригласивший, первая
    -- заявка на реферала побеждает, повторный claim того же приглашённого
    -- (в том числе по другой ссылке) не создаёт вторую запись. rewarded_at
    -- NULL, пока приглашённый не собрал свой первый план (см.
    -- maybeRewardReferral) — до этого момента реферал "висит", наградные дни
    -- ещё не начислены никому.
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_telegram_id INTEGER NOT NULL,
      referred_telegram_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      rewarded_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_telegram_id, rewarded_at);
  `);

  // НАЙДЕНО ЖИВЬЁМ НА PRODUCTION (лог Render: "no such column: is_pro"):
  // is_pro появился в строке CREATE TABLE IF NOT EXISTS users не с первого
  // коммита бэкенда (56ae78d создал users БЕЗ is_pro), а позже (99307fc)
  // добавлен прямо в текст CREATE TABLE — а IF NOT EXISTS ничего не делает,
  // если таблица уже есть. На Render диск персистентный: таблица users была
  // создана ЕЩЁ на самом первом деплое и с тех пор ни разу не пересоздавалась
  // — колонка is_pro физически ни разу не появилась в реальной базе, только
  // в тексте схемы для НОВЫХ баз (тесты — все на ":memory:", там её как раз
  // создаёт CREATE TABLE с нуля, поэтому баг был не виден ни в одном тесте).
  // Значит getUserPro/setUserPro (а с ними — реальный лимит "1 план в
  // неделю" и ручная выдача Pro через scripts/set-pro.js) скорее всего либо
  // никогда не работали на проде, либо тихо ломались с этой же ошибкой —
  // до сих пор просто не было кода, который бы её ЛОВИЛ и логировал
  // (proRenewalTick стал первым, кто попытался прочитать is_pro и упал
  // видимым логом). ensureColumn — тот же безопасный паттерн, что уже
  // применён ниже для pro_until и остальных полей.
  ensureColumn(db, "users", "is_pro", "INTEGER NOT NULL DEFAULT 0");

  // pro_until — платная подписка ТЕПЕРЬ ограничена по времени (одноразовый
  // платёж на срок, см. terms.html раздел 3 — "не продлевается
  // автоматически"), в отличие от старого is_pro (бессрочный ручной
  // переключатель, см. scripts/set-pro.js — им всё ещё удобно выдавать себе
  // Pro для тестирования, не оплачивая). getUserPro ниже проверяет ОБА поля:
  // is_pro=1 ИЛИ pro_until в будущем — ручной тумблер продолжает работать
  // как раньше, реальная оплата просто добавляет второй, ограниченный по
  // времени способ стать Pro. renewal_reminder_sent_at — чтобы не слать
  // "подписка скоро закончится" каждый день подряд, пока не наступит день,
  // когда она реально закончится (см. proRenewal.js).
  ensureColumn(db, "users", "pro_until", "TEXT");
  ensureColumn(db, "users", "renewal_reminder_sent_at", "TEXT");
  // Вес/объём упаковки, распарсенный из названия товара ВкусВилл (см.
  // vkusvillPrices.js: parsePackageAmount) — большинство товаров там
  // продаются "поштучно" (unit: "шт" = 1 упаковка), а настоящий вес зашит
  // только в текст названия ("Фарш из индейки, 500 г"). Без этих двух колонок
  // кэш отдавал бы этот случай так же, как раньше отдавал живой резолвинг —
  // "шт" без веса, а он не совпадает с граммами/мл в рецепте почти никогда.
  ensureColumn(db, "ingredient_prices", "package_amount", "REAL");
  ensureColumn(db, "ingredient_prices", "package_unit", "TEXT");

  return db;
}

/** Сырые строки кэша по именам, БЕЗ фильтра свежести — что считать
 * "устаревшим" решает вызывающий код (vkusvillPrices.js: разный TTL для
 * matched и не-matched записей), это не забота слоя хранения. */
export function getIngredientPricesByName(db, names) {
  if (names.length === 0) return new Map();
  const placeholders = names.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT name, matched, price, product_unit, xml_id, package_amount, package_unit, updated_at FROM ingredient_prices WHERE name IN (${placeholders})`)
    .all(...names);
  return new Map(
    rows.map((r) => [
      r.name,
      { matched: !!r.matched, price: r.price, productUnit: r.product_unit, xmlId: r.xml_id, packageAmount: r.package_amount, packageUnit: r.package_unit, updatedAt: r.updated_at },
    ])
  );
}

/** entries: [{name, matched, price, productUnit, xmlId, packageAmount, packageUnit}]
 * — одной транзакцией, чтобы большой список ингредиентов одного плана не
 * оставлял БД в частично обновлённом состоянии при сбое посреди записи. */
export function upsertIngredientPrices(db, entries, updatedAtISO) {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO ingredient_prices (name, matched, price, product_unit, xml_id, package_amount, package_unit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       matched = excluded.matched, price = excluded.price,
       product_unit = excluded.product_unit, xml_id = excluded.xml_id,
       package_amount = excluded.package_amount, package_unit = excluded.package_unit, updated_at = excluded.updated_at`
  );
  db.exec("BEGIN");
  try {
    for (const e of entries) {
      stmt.run(e.name, e.matched ? 1 : 0, e.price ?? null, e.productUnit ?? null, e.xmlId ?? null, e.packageAmount ?? null, e.packageUnit ?? null, updatedAtISO);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
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
 * функции reminderTiming.findDueReminders(), не в SQL.
 *
 * nowISO обязателен и фильтрует по Pro — тот же вывод из ревью, что и в
 * чате: "Напоминания от бота" рекламируются как Pro-бонус, а по факту
 * отправлялись вообще всем, независимо от тарифа. Условие — то же самое,
 * что в getUserPro (ручной тумблер is_pro ИЛИ действующий pro_until),
 * продублировано здесь в SQL по той же причине, что и остальные подобные
 * дубли в этом файле — простое JOIN-условие проще и быстрее одного SQL-
 * запроса, чем тянуть все строки и фильтровать в JS построчно. */
export function findCandidateSlots(db, todayISO, tomorrowISO, nowISO) {
  return db
    .prepare(
      `SELECT ms.id, ms.telegram_user_id, ms.scheduled_date, ms.meal_type, ms.meal_label, ms.meal_time, ms.recipe_name,
              u.timezone_offset_minutes, u.reminder_lead_minutes
       FROM meal_slots ms
       JOIN users u ON u.telegram_user_id = ms.telegram_user_id
       WHERE ms.reminder_sent_at IS NULL
         AND ms.scheduled_date IN (?, ?)
         AND (u.is_pro = 1 OR (u.pro_until IS NOT NULL AND u.pro_until > ?))`
    )
    .all(todayISO, tomorrowISO, nowISO);
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

/** nowISO обязателен (см. ensureColumn/pro_until выше и общий принцип файла —
 * db.js не читает часы сам, только сравнивает переданные строки ISO). */
export function getUserPro(db, telegramUserId, nowISO) {
  const row = db.prepare("SELECT is_pro, pro_until FROM users WHERE telegram_user_id = ?").get(telegramUserId);
  if (!row) return false;
  return !!row.is_pro || (!!row.pro_until && row.pro_until > nowISO);
}

/** Продлевает/выставляет срок действия Pro по факту оплаты — НЕ трогает
 * is_pro (ручной тумблер admin'а — отдельная, независимая причина быть Pro,
 * см. комментарий у ensureColumn). Если у пользователя уже была активная
 * (ещё не истёкшая) оплаченная подписка — продлеваем от даты ЕЁ окончания,
 * а не от "сейчас", чтобы повторная оплата ДО истечения текущего периода не
 * теряла уже оплаченные дни. Если не было или уже истекла — считаем от now. */
export function extendUserPro(db, telegramUserId, { fromISO, addDays }) {
  const row = db.prepare("SELECT pro_until FROM users WHERE telegram_user_id = ?").get(telegramUserId);
  const base = row?.pro_until && row.pro_until > fromISO ? row.pro_until : fromISO;
  const until = new Date(new Date(base).getTime() + addDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO users (telegram_user_id, pro_until) VALUES (?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET pro_until = excluded.pro_until`
  ).run(telegramUserId, until);
  return until;
}

/** Создаёт "ожидающую" запись сразу после создания платежа в ЮKassa (см.
 * app.js: POST /api/pay/create) — до подтверждения вебхуком/повторной
 * проверкой статуса (см. yookassa.js). Позволяет увидеть в БД даже те
 * платежи, которые пользователь так и не завершил. */
export function createPendingPayment(db, { yookassaPaymentId, telegramUserId, amountRub, createdAtISO }) {
  db.prepare(
    `INSERT INTO payments (yookassa_payment_id, telegram_user_id, amount_rub, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(yookassaPaymentId, telegramUserId, amountRub, createdAtISO);
}

export function getPaymentByYookassaId(db, yookassaPaymentId) {
  return db.prepare("SELECT * FROM payments WHERE yookassa_payment_id = ?").get(yookassaPaymentId) ?? null;
}

/** Обновляет статус существующего платежа — вызывается ТОЛЬКО после того,
 * как сам статус подтверждён прямым запросом к ЮKassa (см. yookassa.js:
 * fetchPaymentStatus), никогда напрямую по телу вебхука: ЮKassa не подписывает
 * уведомления, доверять их содержимому без перепроверки — значит позволить
 * кому угодно в интернете "оплатить" подписку одним поддельным POST-запросом. */
export function updatePaymentStatus(db, { yookassaPaymentId, status, confirmedAtISO }) {
  db.prepare("UPDATE payments SET status = ?, confirmed_at = COALESCE(?, confirmed_at) WHERE yookassa_payment_id = ?").run(
    status, confirmedAtISO ?? null, yookassaPaymentId
  );
}

/** Пользователи, у которых оплаченный период (pro_until) заканчивается в
 * ближайшие windowMs и кому ещё не слали напоминание О ЭТОМ ЖЕ истечении
 * (renewal_reminder_sent_at либо не выставлен, либо старше pro_until самого
 * предыдущего периода — сравниваем с pro_until - windowMs, а не просто "было
 * ли когда-либо отправлено", иначе после реального продления подписки
 * напоминание больше никогда не пришло бы снова). is_pro=1 (ручной тумблер)
 * исключаем — у него нет даты истечения, слать "подписка скоро закончится"
 * бессмысленно и вводит в заблуждение. */
export function getUsersWithProExpiringSoon(db, { nowISO, windowMs }) {
  const untilBefore = new Date(new Date(nowISO).getTime() + windowMs).toISOString();
  const rows = db
    .prepare(
      `SELECT telegram_user_id, pro_until, renewal_reminder_sent_at FROM users
       WHERE is_pro = 0 AND pro_until IS NOT NULL AND pro_until > ? AND pro_until <= ?`
    )
    .all(nowISO, untilBefore);
  // "уже напоминали про ЭТО истечение" — не просто "когда-либо напоминали":
  // сравниваем не абсолютное время последнего напоминания с текущим now (SQL
  // не умеет вычитать миллисекунды из ISO-строки без хрупкой date-арифметики
  // прямо в запросе), а РАССТОЯНИЕ между тем напоминанием и ТЕКУЩИМ pro_until.
  // Если пользователь продлил подписку (pro_until стал заметно позже), это
  // расстояние резко вырастет за пределы windowMs — и напоминание сможет
  // прийти снова для нового периода, а не молчать до конца времён после
  // первого же продления.
  return rows
    .filter((r) => {
      if (!r.renewal_reminder_sent_at) return true;
      const gapMs = new Date(r.pro_until).getTime() - new Date(r.renewal_reminder_sent_at).getTime();
      return gapMs > windowMs;
    })
    .map((r) => ({ telegram_user_id: r.telegram_user_id, pro_until: r.pro_until }));
}

export function markRenewalReminderSent(db, telegramUserId, sentAtISO) {
  db.prepare("UPDATE users SET renewal_reminder_sent_at = ? WHERE telegram_user_id = ?").run(sentAtISO, telegramUserId);
}

/** Для дневного отчёта админу (см. digest.js) — сколько платежей завершилось
 * успехом за период и на какую сумму. Другие статусы (pending/canceled)
 * сюда сознательно не идут — админу интересно "сколько купили", а не
 * "сколько раз кто-то начал и передумал". */
export function summarizePaymentsSince(db, sinceISO) {
  const row = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_rub), 0) AS totalRub FROM payments WHERE status = 'succeeded' AND confirmed_at >= ?")
    .get(sinceISO);
  return { count: row.count, totalRub: row.totalRub };
}

/** "Уже существует" = хоть раз появился в users — не обязательно с планом,
 * достаточно строки (её создаёт, например, updateMealTimesForUser не
 * создаёт — а вот saveUserPlan/setUserPro создают). Используется, чтобы
 * реферальную заявку мог создать только ДЕЙСТВИТЕЛЬНО новый человек, а не
 * существующий пользователь под видом нового (см. referrals.js). */
export function userExists(db, telegramUserId) {
  return !!db.prepare("SELECT 1 FROM users WHERE telegram_user_id = ?").get(telegramUserId);
}

/** referred_telegram_id UNIQUE — если заявка на этого приглашённого уже
 * была (в том числе от другого пригласившего), INSERT бросит исключение;
 * вызывающий код (referrals.js) ловит это и считает "уже приглашён", не
 * падает. */
export function claimReferral(db, { referrerTelegramId, referredTelegramId, createdAtISO }) {
  db.prepare("INSERT INTO referrals (referrer_telegram_id, referred_telegram_id, created_at) VALUES (?, ?, ?)").run(
    referrerTelegramId, referredTelegramId, createdAtISO
  );
}

export function getPendingReferral(db, referredTelegramId) {
  return db.prepare("SELECT * FROM referrals WHERE referred_telegram_id = ? AND rewarded_at IS NULL").get(referredTelegramId) ?? null;
}

export function markReferralRewarded(db, referredTelegramId, rewardedAtISO) {
  db.prepare("UPDATE referrals SET rewarded_at = ? WHERE referred_telegram_id = ?").run(rewardedAtISO, referredTelegramId);
}

/** Сколько раз этот пригласивший УЖЕ получил награду — для потолка (см.
 * MAX_REFERRAL_REWARDS в referrals.js), чтобы не разбогатеть на днях Pro
 * бесконечно, создавая (или уговаривая создать) новые аккаунты. */
export function countRewardedReferrals(db, referrerTelegramId) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM referrals WHERE referrer_telegram_id = ? AND rewarded_at IS NOT NULL").get(referrerTelegramId);
  return row.count;
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
