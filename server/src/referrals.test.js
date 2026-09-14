import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, setUserPro, getUserPro, countRewardedReferrals } from "./db.js";
import { claimReferral, maybeRewardReferral, REFERRAL_REWARD_DAYS, MAX_REWARDED_REFERRALS, buildReferralRewardText } from "./referrals.js";

vi.mock("./telegram.js", () => ({ sendTelegramMessage: vi.fn() }));
import { sendTelegramMessage } from "./telegram.js";

const NOW_ISO = "2026-09-10T09:00:00.000Z";

describe("claimReferral", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("создаёт заявку на нового пользователя", () => {
    expect(claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 2, nowISO: NOW_ISO })).toEqual({ ok: true });
  });

  it("отклоняет самоприглашение", () => {
    const result = claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 1, nowISO: NOW_ISO });
    expect(result.ok).toBe(false);
  });

  it("отклоняет приглашение УЖЕ существующего пользователя (не новый)", () => {
    setUserPro(db, 2, false); // создаёт строку users для 2 — "уже существует"
    const result = claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 2, nowISO: NOW_ISO });
    expect(result.ok).toBe(false);
  });

  it("повторная заявка на ТОГО ЖЕ приглашённого (в том числе от другого пригласившего) — отклоняется", () => {
    claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 2, nowISO: NOW_ISO });
    const second = claimReferral(db, { referrerTelegramId: 999, referredTelegramId: 2, nowISO: NOW_ISO });
    expect(second.ok).toBe(false);
  });

  it("один и тот же пригласивший может пригласить НЕСКОЛЬКИХ разных людей", () => {
    expect(claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 2, nowISO: NOW_ISO }).ok).toBe(true);
    expect(claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 3, nowISO: NOW_ISO }).ok).toBe(true);
  });
});

describe("maybeRewardReferral", () => {
  let db;
  beforeEach(() => {
    db = openDb(":memory:");
    vi.clearAllMocks();
  });

  it("нет ожидающего реферала — ничего не делает", async () => {
    const result = await maybeRewardReferral(db, 2, { botToken: "T" }, NOW_ISO);
    expect(result).toEqual({ rewarded: false });
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("есть ожидающий реферал — начисляет Pro ОБЕИМ сторонам и уведомляет пригласившего", async () => {
    claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 2, nowISO: NOW_ISO });
    sendTelegramMessage.mockResolvedValue({ message_id: 1 });

    const result = await maybeRewardReferral(db, 2, { botToken: "T" }, NOW_ISO);
    expect(result).toEqual({ rewarded: true, referrerTelegramId: 1, referrerRewarded: true });

    const inFuture = new Date(new Date(NOW_ISO).getTime() + REFERRAL_REWARD_DAYS * 24 * 3_600_000 - 1000).toISOString();
    expect(getUserPro(db, 1, inFuture)).toBe(true); // пригласивший
    expect(getUserPro(db, 2, inFuture)).toBe(true); // приглашённый

    expect(sendTelegramMessage).toHaveBeenCalledWith("T", 1, buildReferralRewardText(REFERRAL_REWARD_DAYS));
  });

  it("не начисляет дважды за одного и того же приглашённого", async () => {
    claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 2, nowISO: NOW_ISO });
    sendTelegramMessage.mockResolvedValue({ message_id: 1 });

    await maybeRewardReferral(db, 2, { botToken: "T" }, NOW_ISO);
    const second = await maybeRewardReferral(db, 2, { botToken: "T" }, NOW_ISO);
    expect(second).toEqual({ rewarded: false });
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("достигнут потолок наград пригласившего — приглашённый всё равно получает Pro, пригласивший и уведомление — нет", async () => {
    // "разгоняем" пригласившего до потолка чужими руками — напрямую вставляем уже вознаграждённые рефералы
    for (let i = 0; i < MAX_REWARDED_REFERRALS; i++) {
      claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 100 + i, nowISO: NOW_ISO });
      await maybeRewardReferral(db, 100 + i, { botToken: "T" }, NOW_ISO);
    }
    expect(countRewardedReferrals(db, 1)).toBe(MAX_REWARDED_REFERRALS);
    sendTelegramMessage.mockClear();

    claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 999, nowISO: NOW_ISO });
    const result = await maybeRewardReferral(db, 999, { botToken: "T" }, NOW_ISO);
    expect(result).toEqual({ rewarded: true, referrerTelegramId: 1, referrerRewarded: false });

    const inFuture = new Date(new Date(NOW_ISO).getTime() + REFERRAL_REWARD_DAYS * 24 * 3_600_000 - 1000).toISOString();
    expect(getUserPro(db, 999, inFuture)).toBe(true); // приглашённый — награда есть
    expect(sendTelegramMessage).not.toHaveBeenCalled(); // пригласивший — потолок, ни награды, ни уведомления
  });

  it("ошибка отправки уведомления не отменяет уже начисленную награду", async () => {
    claimReferral(db, { referrerTelegramId: 1, referredTelegramId: 2, nowISO: NOW_ISO });
    sendTelegramMessage.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));

    const result = await maybeRewardReferral(db, 2, { botToken: "T" }, NOW_ISO);
    expect(result.rewarded).toBe(true);
    const inFuture = new Date(new Date(NOW_ISO).getTime() + REFERRAL_REWARD_DAYS * 24 * 3_600_000 - 1000).toISOString();
    expect(getUserPro(db, 1, inFuture)).toBe(true);
  });
});
