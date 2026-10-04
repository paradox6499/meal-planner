import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runCatalogMonitorTick, getCatalogState, resetCatalogState } from "./catalogMonitor.js";
import { resetUpstreamGate } from "./vkusvillPrices.js";
import { buildDigestText } from "./digest.js";

const mcpOk = () => ({ ok: true, json: async () => ({ result: { content: [{ text: JSON.stringify({ ok: true, data: { items: [{ id: 1 }] } }) }] } }) });
const mcp403 = () => ({ ok: false, status: 403, json: async () => ({}) });

let telegramCalls;
function stub(mcpImpl) {
  telegramCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
    if (String(url).includes("api.telegram.org")) {
      telegramCalls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    }
    return mcpImpl();
  }));
}
const OPTS = { botToken: "T", adminTelegramId: 777 };

beforeEach(() => {
  resetCatalogState();
  resetUpstreamGate();
});
afterEach(() => vi.unstubAllGlobals());

describe("runCatalogMonitorTick", () => {
  it("первая неудача — без алерта (может быть случайность), вторая подряд — алерт админу", async () => {
    stub(mcp403);
    await runCatalogMonitorTick(OPTS);
    expect(telegramCalls).toHaveLength(0);
    await runCatalogMonitorTick(OPTS);
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].chat_id).toBe(777);
    expect(telegramCalls[0].text).toContain("HTTP 403");
    expect(getCatalogState().ok).toBe(false);
  });

  it("дальше пока недоступно — повторных алертов нет", async () => {
    stub(mcp403);
    for (let i = 0; i < 5; i++) await runCatalogMonitorTick(OPTS);
    expect(telegramCalls).toHaveLength(1);
  });

  it("восстановился — одно сообщение об этом", async () => {
    stub(mcp403);
    await runCatalogMonitorTick(OPTS);
    await runCatalogMonitorTick(OPTS);
    stub(mcpOk);
    await runCatalogMonitorTick(OPTS);
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].text).toContain("снова отвечает");
    expect(getCatalogState().ok).toBe(true);
  });

  it("всё в порядке с самого начала — тишина", async () => {
    stub(mcpOk);
    await runCatalogMonitorTick(OPTS);
    await runCatalogMonitorTick(OPTS);
    expect(telegramCalls).toHaveLength(0);
  });

  it("без adminTelegramId не шлёт, но состояние ведёт", async () => {
    stub(mcp403);
    await runCatalogMonitorTick({ botToken: "T" });
    await runCatalogMonitorTick({ botToken: "T" });
    expect(telegramCalls).toHaveLength(0);
    expect(getCatalogState().ok).toBe(false);
  });
});

describe("дайджест: каталог недоступен", () => {
  const empty = { totalEvents: 0, byName: [], recentErrors: [] };
  it("показывает строку про каталог первой", () => {
    const text = buildDigestText(empty, { sinceISO: "2026-10-03T09:00:00Z", now: new Date("2026-10-04T09:00:00Z"), catalogDown: { detail: "VkusVill MCP: HTTP 403", httpStatus: 403 } });
    expect(text.split("\n")[2]).toContain("ВкусВилл с сервера не отвечает");
    expect(text).toContain("HTTP 403");
  });
  it("когда всё хорошо — строки нет", () => {
    expect(buildDigestText(empty, { sinceISO: "2026-10-03T09:00:00Z", now: new Date("2026-10-04T09:00:00Z") })).not.toContain("не отвечает");
  });
});
