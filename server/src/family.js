// "Общий список на семью" — Pro-бонус (живой вывод из ревью в чате: раньше
// рекламировался, а по факту не существовал вообще — ни общего аккаунта, ни
// синхронизации между устройствами). Семья тут не про родство, а про группу
// Telegram-аккаунтов, которые видят один и тот же "уже есть дома" (см.
// db.js: family_pantry, src/lib/pantry.js на фронтенде за тем же смыслом
// без семьи). Приглашение — ссылка t.me/s_edim_bot?startapp=fam_<invite_code>
// — случайный код (db.js: genInviteCode/families.invite_code), НЕ id семьи:
// сам нашёл до жалобы в чате, пока строил — id это маленькое предсказуемое
// AUTOINCREMENT-число, подставить соседнее и напроситься в чужую семью было
// бы совсем не сложно.
import {
  createFamily as dbCreateFamily, getFamilyByInviteCode, getFamilyForUser, getFamilyMembers, countFamilyMembers,
  addFamilyMember, removeFamilyMember, dissolveFamily, getFamilyPantry, setFamilyPantryItem,
} from "./db.js";

// Реалистичный размер семьи/квартиры — тот же порядок величин, что MAX_PRO_SLOTS
// (несколько планов) и MAX_REWARDED_REFERRALS в referrals.js: разумный
// потолок без реального сценария, где он мешает, но и без риска, что кто-то
// заведёт "семью" из полусотни левых аккаунтов ради самого статуса.
export const MAX_FAMILY_MEMBERS = 6;

/** Создать семью — вызывающий код (app.js) сам проверяет Pro ДО вызова, эта
 * функция только проверяет "не состоит ли уже в какой-то семье" (в том числе
 * в своей же, повторно). */
export function createFamily(db, { ownerTelegramId, ownerDisplayName, nowISO }) {
  if (getFamilyForUser(db, ownerTelegramId)) {
    return { ok: false, reason: "вы уже состоите в семье — сначала покиньте текущую" };
  }
  const familyId = dbCreateFamily(db, { ownerTelegramId, ownerDisplayName, nowISO });
  return { ok: true, familyId };
}

/** inviteCode — из ссылки t.me/s_edim_bot?startapp=fam_<invite_code> (см.
 * шапку файла за тем, почему это код, а не id семьи). referredTelegramId
 * уже переиспользуется в других файлах как имя для "тот, кто сейчас
 * выполняет действие" — здесь называю его joiningTelegramId для ясности,
 * семантика та же. */
export function joinFamily(db, { inviteCode, joiningTelegramId, displayName, nowISO }) {
  const family = getFamilyByInviteCode(db, inviteCode);
  if (!family) return { ok: false, reason: "приглашение недействительно — семья не найдена" };
  if (getFamilyForUser(db, joiningTelegramId)) {
    return { ok: false, reason: "вы уже состоите в семье — сначала покиньте текущую" };
  }
  if (countFamilyMembers(db, family.id) >= MAX_FAMILY_MEMBERS) {
    return { ok: false, reason: `в семье уже максимум участников (${MAX_FAMILY_MEMBERS})` };
  }
  addFamilyMember(db, { familyId: family.id, telegramUserId: joiningTelegramId, displayName, nowISO });
  return { ok: true, familyId: family.id };
}

/** Владелец покидает — семья распускается целиком (см. dissolveFamily в
 * db.js за обоснованием); обычный участник — просто выходит, семья остаётся
 * с остальными. */
export function leaveFamily(db, telegramUserId) {
  const family = getFamilyForUser(db, telegramUserId);
  if (!family) return { ok: false, reason: "вы не состоите в семье" };
  if (family.owner_telegram_id === telegramUserId) {
    dissolveFamily(db, family.id);
  } else {
    removeFamilyMember(db, telegramUserId);
  }
  return { ok: true };
}

/** Единая сводка для фронтенда (POST /api/family/status) — inFamily:false,
 * если человек ни в какой семье не состоит, остальные поля тогда не нужны. */
export function getFamilyStatus(db, telegramUserId) {
  const family = getFamilyForUser(db, telegramUserId);
  if (!family) return { inFamily: false };
  return {
    inFamily: true,
    familyId: family.id,
    // inviteCode — фронтенд строит ссылку t.me/s_edim_bot?startapp=fam_<inviteCode>
    // (см. AccountView: FamilySection, кнопка "Пригласить ещё" — только у
    // владельца). Отдаём его любому участнику, не только владельцу — сама
    // ссылка не секретна для УЖЕ состоящих в семье, секретность держится на
    // непредсказуемости кода, а не на том, кто его видит внутри семьи.
    inviteCode: family.invite_code,
    isOwner: family.owner_telegram_id === telegramUserId,
    members: getFamilyMembers(db, family.id).map((m) => ({ telegramUserId: m.telegram_user_id, displayName: m.display_name, joinedAt: m.joined_at })),
    pantryNames: getFamilyPantry(db, family.id),
  };
}

/** Отметить/снять "уже есть дома" для всей семьи сразу — присутствовать в
 * семье ОБЯЗАТЕЛЬНО (см. app.js: 400, если inFamily:false), иначе неясно, в
 * чей family_pantry вообще писать. */
export function toggleFamilyPantryItem(db, { telegramUserId, name, present }) {
  const family = getFamilyForUser(db, telegramUserId);
  if (!family) return { ok: false, reason: "вы не состоите в семье" };
  setFamilyPantryItem(db, family.id, name, present);
  return { ok: true, pantryNames: getFamilyPantry(db, family.id) };
}
