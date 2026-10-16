import { describe, it, expect, vi, afterEach } from "vitest";
import { applyBotProfile, BOT_COMMANDS, BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION } from "./botProfile.js";

afterEach(() => vi.unstubAllGlobals());

describe("applyBotProfile", () => {
  it("тексты укладываются в лимиты Telegram", () => {
    expect(BOT_DESCRIPTION.length).toBeLessThanOrEqual(512);
    expect(BOT_SHORT_DESCRIPTION.length).toBeLessThanOrEqual(120);
    for (const c of BOT_COMMANDS) {
      expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("выставляет команды и оба описания", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => { calls.push([url, JSON.parse(opts.body)]); return { ok: true, json: async () => ({ ok: true, result: true }) }; }));
    expect(await applyBotProfile("T:K")).toEqual([]);
    expect(calls.map(([u]) => u.split("/").pop())).toEqual(["setMyCommands", "setMyDescription", "setMyShortDescription"]);
    expect(calls[0][1].commands.map((c) => c.command)).toEqual(["start", "help", "support"]);
  });

  it("сбой одного вызова не мешает остальным и не бросает", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).endsWith("setMyDescription")
      ? { ok: false, status: 400, json: async () => ({ ok: false, description: "bad" }) }
      : { ok: true, json: async () => ({ ok: true }) })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await applyBotProfile("T:K")).toEqual(["setMyDescription"]);
  });
});
