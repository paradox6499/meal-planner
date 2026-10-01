// Регулярная уборка БД — чтобы диск (на Render он небольшой и один на всё,
// включая деньги за подписки) не заполнялся сам собой (аудит 29.09.2026: у
// events не было срока хранения вообще, а ingredient_prices навсегда
// запоминал даже выдуманные названия). Один "тик", как у остальных
// планировщиков (reminderTiming.js, digest.js, backup.js) — вызывается из
// index.js по расписанию.
import { purgeOldEvents, purgeOldIngredientPrices } from "./db.js";

// 90 дней — с огромным запасом над самым длинным окном, которое смотрит
// код по events (бесплатный лимит — 7 дней, напоминание вернуться — ~10),
// и достаточно для ретроспективы дневных отчётов.
export const EVENTS_RETENTION_DAYS = 90;
export const PRICES_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function runMaintenance(db, now = new Date()) {
  const eventsDeleted = purgeOldEvents(db, new Date(now.getTime() - EVENTS_RETENTION_DAYS * DAY_MS).toISOString());
  const pricesDeleted = purgeOldIngredientPrices(db, new Date(now.getTime() - PRICES_RETENTION_DAYS * DAY_MS).toISOString());
  return { eventsDeleted, pricesDeleted };
}
