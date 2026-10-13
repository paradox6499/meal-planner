// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

vi.mock("../lib/backend.js", () => ({
  createFamily: vi.fn(), joinFamily: vi.fn(), leaveFamily: vi.fn(), toggleFamilyPantryItem: vi.fn(),
  fetchFamilyStatus: vi.fn(),
}));
vi.mock("../lib/analytics.js", () => ({ trackEvent: vi.fn() }));
vi.mock("../lib/haptics.js", () => ({ hapticImpact: vi.fn() }));
import { fetchFamilyStatus, joinFamily } from "../lib/backend.js";
import { useFamily, FAMILY_POLL_MS } from "./useFamily.js";

const owner = (n) => ({ ok: true, status: { inFamily: true, isOwner: true, members: Array.from({ length: n }, (_, i) => ({ id: i })) } });

describe("useFamily: новый участник появляется у владельца", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.Telegram;
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("пока открыт Аккаунт, статус семьи перезапрашивается сам", async () => {
    vi.useFakeTimers();
    fetchFamilyStatus.mockResolvedValue(owner(1));
    const { result } = renderHook(() => useFamily({ showAccount: true }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.familyStatus.members).toHaveLength(1);

    fetchFamilyStatus.mockResolvedValue(owner(2)); // за это время человек вступил
    await act(async () => { await vi.advanceTimersByTimeAsync(FAMILY_POLL_MS + 10); });
    expect(result.current.familyStatus.members).toHaveLength(2);
  });

  it("при возврате в приложение статус тоже обновляется", async () => {
    fetchFamilyStatus.mockResolvedValue(owner(1));
    const { result } = renderHook(() => useFamily({ showAccount: false }));
    await waitFor(() => expect(result.current.familyStatus?.members).toHaveLength(1));

    fetchFamilyStatus.mockResolvedValue(owner(2));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(result.current.familyStatus.members).toHaveLength(2));
  });
});

describe("useFamily: вступление по ссылке", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFamilyStatus.mockResolvedValue({ ok: true, status: { inFamily: false } });
    window.Telegram = { WebApp: { initDataUnsafe: { start_param: "fam_AbC123" } } };
  });
  afterEach(() => { cleanup(); delete window.Telegram; });

  it("отказ сервера не молчит: причина попадает в familyJoinError", async () => {
    joinFamily.mockResolvedValue({ ok: false, error: "вы уже состоите в семье — сначала покиньте текущую" });
    const { result } = renderHook(() => useFamily({ showAccount: false }));
    await waitFor(() => expect(result.current.familyJoinError).toMatch(/уже состоите/));
    expect(result.current.familyJoinedNote).toBe(false);
  });

  it("успех — заметка о вступлении, ошибки нет", async () => {
    joinFamily.mockResolvedValue({ ok: true, status: { inFamily: true, members: [] } });
    const { result } = renderHook(() => useFamily({ showAccount: false }));
    await waitFor(() => expect(result.current.familyJoinedNote).toBe(true));
    expect(result.current.familyJoinError).toBeNull();
  });
});
