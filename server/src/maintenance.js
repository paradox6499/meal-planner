// Регулярная уборка БД — чтобы диск (на Render он небольшой и один на всё,
// включая деньги за подписки) не заполнялся сам собой (аудит 29.09.2026: у
// events не было срока хранения вообще, а ingredient_prices навсегда
// запоминал даже выдуманные названия). Один "тик", как у остальных
// планировщиков (reminderTiming.js, digest.js, backup.js) — вызывается из
// index.js по расписанию.
import { purgeOldEvents, purgeOldIngredientPrices, purgeOldDeletedAccounts, purgeOldWarmTargets } from "./db.js";

// 90 дней — с огромным запасом над самым длинным окном, которое смотрит
// код по events (бесплатный лимит — 7 дней, напоминание вернуться — ~10),
// и достаточно для ретроспективы дневных отчётов.
export const EVENTS_RETENTION_DAYS = 90;
export const PRICES_RETENTION_DAYS = 30;
// Надгробия удалённых аккаунтов (см. deleted_accounts в db.js) держим год —
// достаточно, чтобы схема "удалить и вернуться за новой наградой" не окупалась,
// и не дольше нужного (хэш идентификатора — всё равно псевдонимизированные
// данные, см. политику конфиденциальности).
export const DELETED_ACCOUNTS_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;
// Сочетание фильтров, которое не спрашивали две недели, подогревать незачем.
export const WARM_TARGETS_RETENTION_DAYS = 14;

export function runMaintenance(db, now = new Date()) {
  const eventsDeleted = purgeOldEvents(db, new Date(now.getTime() - EVENTS_RETENTION_DAYS * DAY_MS).toISOString());
  const pricesDeleted = purgeOldIngredientPrices(db, new Date(now.getTime() - PRICES_RETENTION_DAYS * DAY_MS).toISOString());
  const deletedAccountsPurged = purgeOldDeletedAccounts(db, new Date(now.getTime() - DELETED_ACCOUNTS_RETENTION_DAYS * DAY_MS).toISOString());
  purgeOldWarmTargets(db, new Date(now.getTime() - WARM_TARGETS_RETENTION_DAYS * DAY_MS).toISOString());
  return { eventsDeleted, pricesDeleted, deletedAccountsPurged };
}
