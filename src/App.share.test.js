import { describe, it, expect } from "vitest";
import { buildShareUrl } from "./App.jsx";

describe("buildShareUrl", () => {
  it("кодирует пробелы как %20, а не как + (регрессия: плюсики в тексте пересланного сообщения)", () => {
    const url = buildShareUrl("Наш план на неделю");
    expect(url).not.toContain("+");
    expect(url).toContain("%20");
  });

  it("многострочный текст (реальный вид сообщения с переносами и отступами) не содержит +", () => {
    const text = "🛒 План\nДень 1:\n  Обед: Паста\n  Ужин: Суп\n\nКак вам? 🙂";
    const url = buildShareUrl(text);
    expect(url).not.toContain("+");
    // round-trip: то, что декодируется из query, должно совпасть с исходным текстом
    const decoded = decodeURIComponent(new URL(url).searchParams.get("text"));
    expect(decoded).toBe(text);
  });

  it("добавляет &url=... только если url передан", () => {
    expect(buildShareUrl("текст")).not.toContain("&url=");
    expect(buildShareUrl("текст", "https://t.me/s_edim_bot")).toContain("&url=https%3A%2F%2Ft.me%2Fs_edim_bot");
  });
});
