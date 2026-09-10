import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { openDb, findCandidateSlots, summarizeEventsSince, setUserPro, insertEvent, listPlanHistory } from "./db.js";
import { createApp, parsePlanRequest, parseEventRequest, parseSavePlanRequest, computePlanStatus, FREE_PLANS_PER_WEEK } from "./app.js";

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

describe("parseEventRequest", () => {
  it("принимает корректное тело", () => {
    const result = parseEventRequest({ eventName: "plan_generated", props: { step: 3 } }, 42);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ telegramUserId: 42, eventName: "plan_generated", props: { step: 3 } });
  });

  it("props необязателен", () => {
    expect(parseEventRequest({ eventName: "share_clicked" }, 42).ok).toBe(true);
  });

  it("отклоняет отсутствующий/пустой/слишком длинный eventName", () => {
    expect(parseEventRequest({}, 42).ok).toBe(false);
    expect(parseEventRequest({ eventName: "" }, 42).ok).toBe(false);
    expect(parseEventRequest({ eventName: "x".repeat(100) }, 42).ok).toBe(false);
  });

  it("отклоняет props не-объект (массив, строку, число)", () => {
    expect(parseEventRequest({ eventName: "x", props: [1, 2] }, 42).ok).toBe(false);
    expect(parseEventRequest({ eventName: "x", props: "oops" }, 42).ok).toBe(false);
    expect(parseEventRequest({ eventName: "x", props: 5 }, 42).ok).toBe(false);
  });

  it("отклоняет слишком большой props", () => {
    expect(parseEventRequest({ eventName: "x", props: { blob: "y".repeat(5000) } }, 42).ok).toBe(false);
  });
});

describe("computePlanStatus", () => {
  it("Pro всегда canGenerate, независимо от usedThisWeek", () => {
    expect(computePlanStatus(true, 5, new Date("2026-09-10T09:00:00Z")).canGenerate).toBe(true);
  });

  it("Free: можно, пока не выбран лимит", () => {
    const status = computePlanStatus(false, 0, new Date("2026-09-10T09:00:00Z"));
    expect(status.canGenerate).toBe(true);
    expect(status.freeLimitPerWeek).toBe(FREE_PLANS_PER_WEEK);
    expect(status.nextResetHint).toBeNull();
  });

  it("Free: заблокировано ровно на лимите, с подсказкой даты сброса", () => {
    const status = computePlanStatus(false, FREE_PLANS_PER_WEEK, new Date("2026-09-10T09:00:00Z"));
    expect(status.canGenerate).toBe(false);
    expect(status.nextResetHint).toBe("2026-09-17T09:00:00.000Z");
  });
});

describe("parseSavePlanRequest", () => {
  const validPlan = { storeId: "vv", storeName: "ВкусВилл", budget: 4000, family: 2, totalCost: 3800, plan: { days: [] } };

  it("принимает корректное тело", () => {
    const result = parseSavePlanRequest(validPlan, 42);
    expect(result.ok).toBe(true);
    expect(result.value.telegramUserId).toBe(42);
  });

  it("totalCost необязателен", () => {
    const { totalCost, ...rest } = validPlan;
    expect(parseSavePlanRequest(rest, 42).ok).toBe(true);
  });

  it("отклоняет отсутствующие/некорректные обязательные поля", () => {
    expect(parseSavePlanRequest({ ...validPlan, storeId: "" }, 42).ok).toBe(false);
    expect(parseSavePlanRequest({ ...validPlan, budget: 0 }, 42).ok).toBe(false);
    expect(parseSavePlanRequest({ ...validPlan, family: -1 }, 42).ok).toBe(false);
    expect(parseSavePlanRequest({ ...validPlan, plan: null }, 42).ok).toBe(false);
    expect(parseSavePlanRequest({ ...validPlan, plan: [1, 2] }, 42).ok).toBe(false);
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

  it("POST /events с валидной initData сохраняет событие", async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), eventName: "plan_generated", props: { step: 5 } }),
    });
    expect(res.status).toBe(200);
    const summary = summarizeEventsSince(db, "2020-01-01T00:00:00Z");
    expect(summary.totalEvents).toBe(1);
    expect(summary.byName[0].event_name).toBe("plan_generated");
  });

  it("POST /events без initData -> 401, ничего не сохраняется", async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventName: "plan_generated" }),
    });
    expect(res.status).toBe(401);
    expect(summarizeEventsSince(db, "2020-01-01T00:00:00Z").totalEvents).toBe(0);
  });

  it("POST /events с валидной initData, но без eventName -> 400", async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/plan-status: free-пользователь без сборок за неделю — можно генерировать", async () => {
    const res = await fetch(`${baseUrl}/api/plan-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, isPro: false, canGenerate: true, usedThisWeek: 0 });
  });

  it("POST /api/plan-status: free-пользователь, уже исчерпавший лимит — canGenerate:false", async () => {
    insertEvent(db, { telegramUserId: 42, eventName: "plan_generated", props: null, createdAtISO: new Date().toISOString() });
    const res = await fetch(`${baseUrl}/api/plan-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    const data = await res.json();
    expect(data.canGenerate).toBe(false);
    expect(data.nextResetHint).toBeTruthy();
  });

  it("POST /api/plan-status: Pro-пользователь может генерировать, даже исчерпав лимит", async () => {
    setUserPro(db, 42, true);
    insertEvent(db, { telegramUserId: 42, eventName: "plan_generated", props: null, createdAtISO: new Date().toISOString() });
    const res = await fetch(`${baseUrl}/api/plan-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    const data = await res.json();
    expect(data).toMatchObject({ isPro: true, canGenerate: true });
  });

  it("POST /api/plan-status без initData -> 401", async () => {
    const res = await fetch(`${baseUrl}/api/plan-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  const validPlanBody = { storeId: "vv", storeName: "ВкусВилл", budget: 4000, family: 2, totalCost: 3800, plan: { days: [] } };

  it("POST /api/plans сохраняет план в историю пользователя", async () => {
    const res = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), ...validPlanBody }),
    });
    expect(res.status).toBe(200);
    expect(listPlanHistory(db, 42)).toHaveLength(1);
  });

  it("POST /api/plans без initData -> 401, ничего не сохраняется", async () => {
    const res = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPlanBody),
    });
    expect(res.status).toBe(401);
    expect(listPlanHistory(db, 42)).toHaveLength(0);
  });

  it("POST /api/plans с валидной initData, но без plan -> 400", async () => {
    const { plan, ...rest } = validPlanBody;
    const res = await fetch(`${baseUrl}/api/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), ...rest }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/plans/list возвращает историю только своего пользователя, новые сверху", async () => {
    await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), ...validPlanBody, budget: 4000 }) });
    await fetch(`${baseUrl}/api/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(7), ...validPlanBody, budget: 9999 }) });

    const res = await fetch(`${baseUrl}/api/plans/list`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42) }) });
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.plans).toHaveLength(1);
    expect(data.plans[0].budget).toBe(4000);
  });

  it("POST /api/plans/list без initData -> 401", async () => {
    const res = await fetch(`${baseUrl}/api/plans/list`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
