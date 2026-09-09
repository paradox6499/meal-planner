import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { openDb, findCandidateSlots } from "./db.js";
import { createApp, parsePlanRequest } from "./app.js";

const BOT_TOKEN = "123456:TEST-TOKEN";

function signInitData(fields, botToken = BOT_TOKEN) {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function validInitData(userId = 42) {
  return signInitData({ user: JSON.stringify({ id: userId, first_name: "Тест" }), auth_date: String(Math.floor(Date.now() / 1000)) });
}

const validSlot = { scheduledDate: "2026-09-10", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" };

describe("parsePlanRequest", () => {
  it("принимает корректное тело", () => {
    const result = parsePlanRequest({ timezoneOffsetMinutes: 180, mealSlots: [validSlot] }, 42);
    expect(result.ok).toBe(true);
    expect(result.value.telegramUserId).toBe(42);
  });

  it("reminderLeadMinutes по умолчанию 30, если не передан", () => {
    const result = parsePlanRequest({ timezoneOffsetMinutes: 180, mealSlots: [validSlot] }, 42);
    expect(result.value.reminderLeadMinutes).toBe(30);
  });

  it("отклоняет отсутствующий/некорректный timezoneOffsetMinutes", () => {
    expect(parsePlanRequest({ mealSlots: [validSlot] }, 42).ok).toBe(false);
    expect(parsePlanRequest({ timezoneOffsetMinutes: 9999, mealSlots: [validSlot] }, 42).ok).toBe(false);
  });

  it("отклоняет пустой mealSlots", () => {
    expect(parsePlanRequest({ timezoneOffsetMinutes: 180, mealSlots: [] }, 42).ok).toBe(false);
    expect(parsePlanRequest({ timezoneOffsetMinutes: 180 }, 42).ok).toBe(false);
  });

  it("отклоняет слот с неизвестным mealType / битой датой / битым временем", () => {
    expect(parsePlanRequest({ timezoneOffsetMinutes: 180, mealSlots: [{ ...validSlot, mealType: "brunch" }] }, 42).ok).toBe(false);
    expect(parsePlanRequest({ timezoneOffsetMinutes: 180, mealSlots: [{ ...validSlot, scheduledDate: "10.09.2026" }] }, 42).ok).toBe(false);
    expect(parsePlanRequest({ timezoneOffsetMinutes: 180, mealSlots: [{ ...validSlot, mealTime: "7pm" }] }, 42).ok).toBe(false);
  });
});

describe("HTTP-сервер", () => {
  let db, server, baseUrl;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it("GET /health отвечает 200 без авторизации", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("POST /api/plan с валидной initData сохраняет план", async () => {
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), timezoneOffsetMinutes: 180, mealSlots: [validSlot] }),
    });
    expect(res.status).toBe(200);
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].telegram_user_id).toBe(42);
  });

  it("POST /api/plan без initData -> 401, ничего не сохраняется", async () => {
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezoneOffsetMinutes: 180, mealSlots: [validSlot] }),
    });
    expect(res.status).toBe(401);
    expect(findCandidateSlots(db, "2026-09-10", "2026-09-11")).toHaveLength(0);
  });

  it("POST /api/plan с ПОДДЕЛЬНОЙ initData -> 401 (нельзя сохранить план за чужого пользователя)", async () => {
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: signInitData({ user: JSON.stringify({ id: 999 }), auth_date: String(Math.floor(Date.now() / 1000)) }, "CHUZHOY:TOKEN"), timezoneOffsetMinutes: 180, mealSlots: [validSlot] }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/plan с валидной initData, но битым телом -> 400", async () => {
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), mealSlots: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("неизвестный маршрут -> 404", async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
  });
});
