import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { validateInitData } from "./initData.js";

const BOT_TOKEN = "123456:TEST-TOKEN-not-a-real-secret";

// Строит валидную initData ровно тем же алгоритмом, что и сама Telegram —
// нужно, чтобы тестировать validateInitData без реального Telegram-клиента.
function signInitData(fields, botToken = BOT_TOKEN) {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function freshFields(overrides = {}) {
  return {
    user: JSON.stringify({ id: 42, first_name: "Ангелина" }),
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAABBB",
    ...overrides,
  };
}

describe("validateInitData", () => {
  it("принимает корректно подписанную initData и достаёт из неё пользователя", () => {
    const initData = signInitData(freshFields());
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.user).toEqual({ id: 42, first_name: "Ангелина" });
  });

  it("отклоняет initData, подписанную ДРУГИМ bot token (чужой бот)", () => {
    const initData = signInitData(freshFields(), "999999:CHUZHOY-TOKEN");
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result.ok).toBe(false);
  });

  it("отклоняет initData с изменённым после подписи полем (подделка user.id)", () => {
    const initData = signInitData(freshFields());
    // Меняем telegram_user_id уже ПОСЛЕ подписи — как будто кто-то пытается
    // выдать себя за другого пользователя, зная только структуру initData.
    const tampered = initData.replace("%22id%22%3A42", "%22id%22%3A999");
    const result = validateInitData(tampered, BOT_TOKEN);
    expect(result.ok).toBe(false);
  });

  it("отклоняет initData без hash вообще", () => {
    const result = validateInitData(new URLSearchParams(freshFields()).toString(), BOT_TOKEN);
    expect(result.ok).toBe(false);
  });

  it("отклоняет пустую/отсутствующую initData, не падая", () => {
    expect(validateInitData("", BOT_TOKEN).ok).toBe(false);
    expect(validateInitData(null, BOT_TOKEN).ok).toBe(false);
    expect(validateInitData(undefined, BOT_TOKEN).ok).toBe(false);
  });

  it("отклоняет, если bot token не настроен на сервере (пустая строка)", () => {
    const initData = signInitData(freshFields());
    expect(validateInitData(initData, "").ok).toBe(false);
  });

  it("отклоняет устаревшую initData (старше maxAgeSeconds)", () => {
    const oldAuthDate = String(Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60); // 3 дня назад
    const initData = signInitData(freshFields({ auth_date: oldAuthDate }));
    const result = validateInitData(initData, BOT_TOKEN, { maxAgeSeconds: 24 * 60 * 60 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/устарела/);
  });

  it("maxAgeSeconds: 0 отключает проверку возраста", () => {
    const oldAuthDate = String(Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60);
    const initData = signInitData(freshFields({ auth_date: oldAuthDate }));
    const result = validateInitData(initData, BOT_TOKEN, { maxAgeSeconds: 0 });
    expect(result.ok).toBe(true);
  });
});
