import { describe, it, expect, beforeEach } from "vitest";
import { openDb, getFamilyForUser } from "./db.js";
import { createFamily, joinFamily, leaveFamily, getFamilyStatus, toggleFamilyPantryItem, MAX_FAMILY_MEMBERS } from "./family.js";

const NOW_ISO = "2026-09-10T09:00:00.000Z";
// joinFamily теперь ищет по коду приглашения, не по id семьи (живая жалоба
// в чате: короткий id легко перебираемый) — этот хелпер достаёт код так же,
// как это делал бы реальный фронтенд (через getFamilyStatus владельца).
const inviteCodeOf = (db, ownerTelegramId) => getFamilyStatus(db, ownerTelegramId).inviteCode;

describe("createFamily", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("создаёт семью, владелец сразу становится участником", () => {
    const result = createFamily(db, { ownerTelegramId: 1, ownerDisplayName: "Женя", nowISO: NOW_ISO });
    expect(result.ok).toBe(true);
    const status = getFamilyStatus(db, 1);
    expect(status.inFamily).toBe(true);
    expect(status.isOwner).toBe(true);
    expect(status.members).toHaveLength(1);
    expect(status.members[0]).toMatchObject({ telegramUserId: 1, displayName: "Женя" });
  });

  it("нельзя создать вторую семью, уже состоя в одной", () => {
    createFamily(db, { ownerTelegramId: 1, ownerDisplayName: null, nowISO: NOW_ISO });
    const second = createFamily(db, { ownerTelegramId: 1, ownerDisplayName: null, nowISO: NOW_ISO });
    expect(second.ok).toBe(false);
  });
});

describe("joinFamily", () => {
  let db, inviteCode;
  beforeEach(() => {
    db = openDb(":memory:");
    createFamily(db, { ownerTelegramId: 1, ownerDisplayName: "Владелец", nowISO: NOW_ISO });
    inviteCode = inviteCodeOf(db, 1);
  });

  it("добавляет нового участника", () => {
    const result = joinFamily(db, { inviteCode, joiningTelegramId: 2, displayName: "Друг", nowISO: NOW_ISO });
    expect(result.ok).toBe(true);
    const status = getFamilyStatus(db, 2);
    expect(status.inFamily).toBe(true);
    expect(status.isOwner).toBe(false);
    expect(status.members.map((m) => m.telegramUserId).sort()).toEqual([1, 2]);
  });

  it("недействительный код приглашения -> явный отказ, не падает", () => {
    const result = joinFamily(db, { inviteCode: "не-существует-такого-кода", joiningTelegramId: 2, displayName: null, nowISO: NOW_ISO });
    expect(result.ok).toBe(false);
  });

  it("код действительно случайный, не совпадает с id семьи (регрессия на живую жалобу — id легко перебираемый)", () => {
    expect(inviteCode).not.toBe("1");
    expect(inviteCode.length).toBeGreaterThan(6);
  });

  it("уже состоит в какой-то семье (в том числе в этой же) -> отказ", () => {
    joinFamily(db, { inviteCode, joiningTelegramId: 2, displayName: null, nowISO: NOW_ISO });
    expect(joinFamily(db, { inviteCode, joiningTelegramId: 2, displayName: null, nowISO: NOW_ISO }).ok).toBe(false);

    createFamily(db, { ownerTelegramId: 3, ownerDisplayName: null, nowISO: NOW_ISO });
    const otherInviteCode = inviteCodeOf(db, 3);
    expect(joinFamily(db, { inviteCode: otherInviteCode, joiningTelegramId: 2, displayName: null, nowISO: NOW_ISO }).ok).toBe(false);
  });

  it(`лимит участников (${MAX_FAMILY_MEMBERS}) — дальше отказ`, () => {
    for (let i = 2; i < 2 + MAX_FAMILY_MEMBERS - 1; i++) {
      expect(joinFamily(db, { inviteCode, joiningTelegramId: i, displayName: null, nowISO: NOW_ISO }).ok).toBe(true);
    }
    // сейчас ровно MAX_FAMILY_MEMBERS участников (владелец + остальные)
    const overflowId = 2 + MAX_FAMILY_MEMBERS - 1 + 100;
    const result = joinFamily(db, { inviteCode, joiningTelegramId: overflowId, displayName: null, nowISO: NOW_ISO });
    expect(result.ok).toBe(false);
  });
});

describe("leaveFamily", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    createFamily(db, { ownerTelegramId: 1, ownerDisplayName: null, nowISO: NOW_ISO });
    joinFamily(db, { inviteCode: inviteCodeOf(db, 1), joiningTelegramId: 2, displayName: null, nowISO: NOW_ISO });
  });

  it("обычный участник выходит — семья остаётся с остальными", () => {
    expect(leaveFamily(db, 2)).toEqual({ ok: true });
    expect(getFamilyForUser(db, 2)).toBeNull();
    const status = getFamilyStatus(db, 1);
    expect(status.inFamily).toBe(true);
    expect(status.members).toHaveLength(1);
  });

  it("владелец выходит — семья распускается целиком, участник 2 тоже выходит", () => {
    expect(leaveFamily(db, 1)).toEqual({ ok: true });
    expect(getFamilyForUser(db, 1)).toBeNull();
    expect(getFamilyForUser(db, 2)).toBeNull();
  });

  it("не состоит в семье -> явный отказ, не падает", () => {
    expect(leaveFamily(db, 999).ok).toBe(false);
  });

  it("после роспуска можно создать/вступить в новую семью", () => {
    leaveFamily(db, 1);
    expect(createFamily(db, { ownerTelegramId: 1, ownerDisplayName: null, nowISO: NOW_ISO }).ok).toBe(true);
  });
});

describe("getFamilyStatus", () => {
  it("не состоит в семье -> {inFamily:false}, без остальных полей", () => {
    const db = openDb(":memory:");
    expect(getFamilyStatus(db, 42)).toEqual({ inFamily: false });
  });
});

// Живой вывод из ревью: "Общий список на семью" — "отметил купленное один
// член семьи — увидят все". family_pantry — тот же смысл, что и локальный
// pantry.js на фронтенде (src/lib/pantry.js), но общий на всю семью.
describe("toggleFamilyPantryItem", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    createFamily(db, { ownerTelegramId: 1, ownerDisplayName: null, nowISO: NOW_ISO });
    joinFamily(db, { inviteCode: inviteCodeOf(db, 1), joiningTelegramId: 2, displayName: null, nowISO: NOW_ISO });
  });

  it("отмечает товар — виден в статусе ЛЮБОГО участника семьи", () => {
    const result = toggleFamilyPantryItem(db, { telegramUserId: 1, name: "Мука", present: true });
    expect(result).toEqual({ ok: true, pantryNames: ["Мука"] });
    expect(getFamilyStatus(db, 2).pantryNames).toEqual(["Мука"]);
  });

  it("снимает отметку", () => {
    toggleFamilyPantryItem(db, { telegramUserId: 1, name: "Мука", present: true });
    const result = toggleFamilyPantryItem(db, { telegramUserId: 2, name: "Мука", present: false });
    expect(result.pantryNames).toEqual([]);
  });

  it("повторная отметка того же товара не плодит дубли", () => {
    toggleFamilyPantryItem(db, { telegramUserId: 1, name: "Соль", present: true });
    const result = toggleFamilyPantryItem(db, { telegramUserId: 2, name: "Соль", present: true });
    expect(result.pantryNames).toEqual(["Соль"]);
  });

  it("не состоит в семье -> явный отказ, не падает", () => {
    expect(toggleFamilyPantryItem(db, { telegramUserId: 999, name: "Соль", present: true }).ok).toBe(false);
  });
});
