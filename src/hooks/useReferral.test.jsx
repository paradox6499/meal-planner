// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

vi.mock("../lib/backend.js", () => ({ claimReferral: vi.fn(), fetchReferralStatus: vi.fn(), checkPlanStatus: vi.fn() }));
import { claimReferral, checkPlanStatus } from "../lib/backend.js";
import { useReferral, useReferralGift } from "./useReferral.js";

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); delete window.Telegram; });

describe("useReferral: приглашённый знает о подарке", () => {
  it("принятое приглашение -> invitedByFriend", async () => {
    window.Telegram = { WebApp: { initDataUnsafe: { start_param: "ref_42" } } };
    claimReferral.mockResolvedValue({ claimed: true, reason: null });
    const { result } = renderHook(() => useReferral({ showAccount: false }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.invitedByFriend).toBe(true);
    expect(result.current.referralNote).toBe(false);
  });

  it("отказ «уже пользовались» -> объяснение, а не подарок", async () => {
    window.Telegram = { WebApp: { initDataUnsafe: { start_param: "ref_42" } } };
    claimReferral.mockResolvedValue({ claimed: false, reason: "пользователь уже существует" });
    const { result } = renderHook(() => useReferral({ showAccount: false }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.invitedByFriend).toBe(false);
    expect(result.current.referralNote).toBe(true);
  });
});

describe("useReferralGift", () => {
  it("план готов, а Pro у приглашённого появился -> дата подарка и обновлённый статус", async () => {
    const onStatus = vi.fn();
    checkPlanStatus.mockResolvedValue({ isPro: true, proUntil: "2026-10-26T10:00:00Z" });
    const { result } = renderHook(() => useReferralGift({ invitedByFriend: true, planReady: true, onStatus }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(result.current).toBe("2026-10-26T10:00:00Z");
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ isPro: true }));
  });

  it("не приглашённый или план ещё не готов — статус не спрашивается", async () => {
    renderHook(() => useReferralGift({ invitedByFriend: false, planReady: true }));
    renderHook(() => useReferralGift({ invitedByFriend: true, planReady: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(checkPlanStatus).not.toHaveBeenCalled();
  });

  it("Pro не появился (награда не начислена) — подарка нет", async () => {
    checkPlanStatus.mockResolvedValue({ isPro: false, proUntil: null });
    const { result } = renderHook(() => useReferralGift({ invitedByFriend: true, planReady: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(result.current).toBeNull();
  });
});
