import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { openDb, findCandidateSlots, summarizeEventsSince, setUserPro, insertEvent, listPlanHistory, listRecentFeedback, createPendingPayment, getPaymentByYookassaId, getUserPro, getExtraPlanCredits, addExtraPlanCredit } from "./db.js";
import { createApp, parsePlanRequest, parseEventRequest, parseSavePlanRequest, parseMealTimesRequest, parsePricesRequest, computePlanStatus, FREE_PLANS_PER_WEEK, EXTRA_PLAN_PRODUCT, EXTRA_PLAN_PRICE_RUB, PRO_PRICE_RUB } from "./app.js";

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
// findCandidateSlots теперь требует nowISO и фильтрует по Pro (живой вывод
// из ревью: напоминания рекламируются как Pro-бонус, а отправлялись всем) —
// см. комментарий у неё в db.js.
const REMINDER_NOW = "2026-09-10T12:00:00Z";

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

  // Живой вывод из ревью: "разовая дешёвая покупка ещё одного плана на этой
  // неделе" — extraPlanCredits прибавляется к базовому бесплатному лимиту.
  it("extraPlanCredits расширяет лимит — можно генерировать сверх базового", () => {
    const status = computePlanStatus(false, FREE_PLANS_PER_WEEK, new Date("2026-09-10T09:00:00Z"), 1);
    expect(status.canGenerate).toBe(true);
    expect(status.extraPlanCredits).toBe(1);
  });

  it("extraPlanCredits тоже кончаются — на лимит+кредиты снова заблокировано", () => {
    const status = computePlanStatus(false, FREE_PLANS_PER_WEEK + 1, new Date("2026-09-10T09:00:00Z"), 1);
    expect(status.canGenerate).toBe(false);
  });

  it("без extraPlanCredits (не передан) — поведение как раньше, extraPlanCredits:0", () => {
    const status = computePlanStatus(false, 0, new Date("2026-09-10T09:00:00Z"));
    expect(status.extraPlanCredits).toBe(0);
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

describe("parseMealTimesRequest", () => {
  it("принимает один или несколько типов приёма пищи", () => {
    expect(parseMealTimesRequest({ mealTimes: { lunch: "13:30" } }, 42)).toEqual({ ok: true, value: { telegramUserId: 42, mealTimes: { lunch: "13:30" } } });
    expect(parseMealTimesRequest({ mealTimes: { lunch: "13:30", dinner: "20:00" } }, 42).ok).toBe(true);
  });

  it("отклоняет отсутствующий/пустой/не-объект mealTimes", () => {
    expect(parseMealTimesRequest({}, 42).ok).toBe(false);
    expect(parseMealTimesRequest({ mealTimes: {} }, 42).ok).toBe(false);
    expect(parseMealTimesRequest({ mealTimes: [] }, 42).ok).toBe(false);
    expect(parseMealTimesRequest({ mealTimes: "13:00" }, 42).ok).toBe(false);
  });

  it("отклоняет неизвестный mealType и неверный формат времени", () => {
    expect(parseMealTimesRequest({ mealTimes: { brunch: "13:00" } }, 42).ok).toBe(false);
    expect(parseMealTimesRequest({ mealTimes: { lunch: "1:00" } }, 42).ok).toBe(false);
    expect(parseMealTimesRequest({ mealTimes: { lunch: "25:00" } }, 42).ok).toBe(true); // формат ЧЧ:ММ, разумность часа не проверяем — тот же уровень строгости, что и у parsePlanRequest
  });
});

describe("parsePricesRequest", () => {
  it("принимает список непустых строк", () => {
    expect(parsePricesRequest({ names: ["Лук", "Морковь"] })).toEqual({ ok: true, value: { names: ["Лук", "Морковь"] } });
  });

  it("отклоняет отсутствующий/пустой/не-массив names", () => {
    expect(parsePricesRequest({}).ok).toBe(false);
    expect(parsePricesRequest({ names: [] }).ok).toBe(false);
    expect(parsePricesRequest({ names: "Лук" }).ok).toBe(false);
  });

  it("отклоняет пустые строки/не-строки внутри names", () => {
    expect(parsePricesRequest({ names: ["Лук", ""] }).ok).toBe(false);
    expect(parsePricesRequest({ names: ["Лук", "   "] }).ok).toBe(false);
    expect(parsePricesRequest({ names: ["Лук", 5] }).ok).toBe(false);
  });

  it("отклоняет слишком длинный список", () => {
    expect(parsePricesRequest({ names: Array.from({ length: 301 }, (_, i) => `товар${i}`) }).ok).toBe(false);
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
    setUserPro(db, 42, true); // findCandidateSlots ниже фильтрует по Pro — сам факт сохранения плана от тарифа не зависит
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11", REMINDER_NOW);
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
    expect(findCandidateSlots(db, "2026-09-10", "2026-09-11", REMINDER_NOW)).toHaveLength(0);
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

  // Живой вывод из ревью: "разовая покупка ещё одного плана" — кредит
  // списывается ровно тогда, когда реально использован (это событие —
  // единственный сигнал "план собран"), не в момент покупки.
  it("plan_generated ПОСЛЕ исчерпания базового лимита списывает один extra_plan_credit", async () => {
    addExtraPlanCredit(db, 42, 2);
    // Первая сборка — в пределах базового лимита (FREE_PLANS_PER_WEEK=1), кредит не трогаем
    await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), eventName: "plan_generated" }) });
    expect(getExtraPlanCredits(db, 42)).toBe(2);

    // Вторая сборка на этой же неделе — сверх базового лимита, идёт за счёт кредита
    await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), eventName: "plan_generated" }) });
    expect(getExtraPlanCredits(db, 42)).toBe(1);
  });

  it("plan_generated в пределах базового лимита не трогает кредиты", async () => {
    addExtraPlanCredit(db, 42, 1);
    await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), eventName: "plan_generated" }) });
    expect(getExtraPlanCredits(db, 42)).toBe(1);
  });

  it("Pro-пользователь никогда не расходует extra_plan_credits (лимит на него не действует)", async () => {
    setUserPro(db, 42, true);
    addExtraPlanCredit(db, 42, 1);
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), eventName: "plan_generated" }) });
    }
    expect(getExtraPlanCredits(db, 42)).toBe(1);
  });

  it("другие события (не plan_generated) не трогают кредиты", async () => {
    addExtraPlanCredit(db, 42, 1);
    await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), eventName: "support_clicked" }) });
    expect(getExtraPlanCredits(db, 42)).toBe(1);
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

  it("POST /api/meal-times обновляет время уже сохранённого плана, не пересобирая его", async () => {
    await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), timezoneOffsetMinutes: 180, mealSlots: [validSlot] }),
    });

    const res = await fetch(`${baseUrl}/api/meal-times`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), mealTimes: { dinner: "20:30" } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, updated: 1 });

    setUserPro(db, 42, true); // findCandidateSlots ниже фильтрует по Pro — обновление времени от тарифа не зависит
    const rows = findCandidateSlots(db, "2026-09-10", "2026-09-11", REMINDER_NOW);
    expect(rows[0].meal_time).toBe("20:30");
  });

  it("POST /api/meal-times без initData -> 401", async () => {
    const res = await fetch(`${baseUrl}/api/meal-times`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mealTimes: { dinner: "20:30" } }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/meal-times с валидной initData, но без mealTimes -> 400", async () => {
    const res = await fetch(`${baseUrl}/api/meal-times`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/referral/claim и /api/referral/status", () => {
  let db, server, baseUrl;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it("claim с валидной initData регистрирует реферала", async () => {
    const res = await fetch(`${baseUrl}/api/referral/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(2), referrerTelegramId: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, claimed: true });
  });

  it("claim без initData -> 401", async () => {
    const res = await fetch(`${baseUrl}/api/referral/claim`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ referrerTelegramId: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("claim без referrerTelegramId -> 400", async () => {
    const res = await fetch(`${baseUrl}/api/referral/claim`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(2) }),
    });
    expect(res.status).toBe(400);
  });

  it("claim самого себя -> 200, но claimed:false (не ошибка HTTP, обычный бизнес-исход)", async () => {
    const res = await fetch(`${baseUrl}/api/referral/claim`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(1), referrerTelegramId: 1 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).claimed).toBe(false);
  });

  it("status без рефералов -> {rewardedCount: 0, daysEarned: 0}", async () => {
    const res = await fetch(`${baseUrl}/api/referral/status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(1) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rewardedCount: 0, daysEarned: 0 });
  });

  it("status без initData -> 401", async () => {
    const res = await fetch(`${baseUrl}/api/referral/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(401);
  });
});

// Живой вывод из ревью Pro-плюшек (чат): "Общий список на семью" —
// рекламировался, а не существовал. POST /api/family/* — см. family.js за
// бизнес-правилами (лимит участников, роспуск при выходе владельца и т.п.),
// здесь — только HTTP-обвязка (авторизация, Pro-гейт на создание, коды ответов).
describe("POST /api/family/*", () => {
  let db, server, baseUrl;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const post = (path, body) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("create без Pro -> 403, семья не создаётся", async () => {
    const res = await post("/api/family/create", { initData: validInitData(1) });
    expect(res.status).toBe(403);
    const statusRes = await post("/api/family/status", { initData: validInitData(1) });
    expect((await statusRes.json()).status).toEqual({ inFamily: false });
  });

  it("create с Pro -> 200, владелец сразу в семье как единственный участник", async () => {
    setUserPro(db, 1, true);
    const res = await post("/api/family/create", { initData: validInitData(1) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status.inFamily).toBe(true);
    expect(body.status.isOwner).toBe(true);
    expect(body.status.members).toHaveLength(1);
  });

  it("create без initData -> 401", async () => {
    const res = await post("/api/family/create", {});
    expect(res.status).toBe(401);
  });

  it("join по inviteCode от владельца-Pro добавляет участника без Pro у самого участника", async () => {
    setUserPro(db, 1, true);
    const createBody = await (await post("/api/family/create", { initData: validInitData(1) })).json();
    const inviteCode = createBody.status.inviteCode;
    expect(inviteCode).toBeTruthy();
    // Регрессия на живую жалобу в чате: короткий id семьи легко перебираем —
    // код приглашения не должен совпадать с id (тут он "1") и должен быть
    // достаточно длинным, чтобы перебор был непрактичен.
    expect(inviteCode).not.toBe(String(createBody.status.familyId));
    expect(inviteCode.length).toBeGreaterThan(6);

    const joinRes = await post("/api/family/join", { initData: validInitData(2), inviteCode });
    expect(joinRes.status).toBe(200);
    const joinBody = await joinRes.json();
    expect(joinBody.status.members.map((m) => m.telegramUserId).sort()).toEqual([1, 2]);
  });

  it("join с несуществующим inviteCode -> 400", async () => {
    const res = await post("/api/family/join", { initData: validInitData(2), inviteCode: "не-существует-такого-кода" });
    expect(res.status).toBe(400);
  });

  it("join без inviteCode -> 400", async () => {
    const res = await post("/api/family/join", { initData: validInitData(2) });
    expect(res.status).toBe(400);
  });

  it("leave владельцем распускает семью — второй участник тоже выходит", async () => {
    setUserPro(db, 1, true);
    const inviteCode = (await (await post("/api/family/create", { initData: validInitData(1) })).json()).status.inviteCode;
    await post("/api/family/join", { initData: validInitData(2), inviteCode });

    const leaveRes = await post("/api/family/leave", { initData: validInitData(1) });
    expect(leaveRes.status).toBe(200);
    expect((await (await post("/api/family/status", { initData: validInitData(2) })).json()).status).toEqual({ inFamily: false });
  });

  it("leave, не состоя в семье -> 400", async () => {
    const res = await post("/api/family/leave", { initData: validInitData(1) });
    expect(res.status).toBe(400);
  });

  it("status без семьи -> {inFamily:false}", async () => {
    const res = await post("/api/family/status", { initData: validInitData(1) });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toEqual({ inFamily: false });
  });

  it("pantry: отметка одним участником видна в статусе другого", async () => {
    setUserPro(db, 1, true);
    const inviteCode = (await (await post("/api/family/create", { initData: validInitData(1) })).json()).status.inviteCode;
    await post("/api/family/join", { initData: validInitData(2), inviteCode });

    const toggleRes = await post("/api/family/pantry", { initData: validInitData(1), name: "Мука", present: true });
    expect(toggleRes.status).toBe(200);
    expect((await toggleRes.json()).pantryNames).toEqual(["Мука"]);

    const status2 = await (await post("/api/family/status", { initData: validInitData(2) })).json();
    expect(status2.status.pantryNames).toEqual(["Мука"]);
  });

  it("pantry без семьи -> 400", async () => {
    const res = await post("/api/family/pantry", { initData: validInitData(1), name: "Мука", present: true });
    expect(res.status).toBe(400);
  });

  it("pantry с некорректным телом (нет present) -> 400", async () => {
    setUserPro(db, 1, true);
    await post("/api/family/create", { initData: validInitData(1) });
    const res = await post("/api/family/pantry", { initData: validInitData(1), name: "Мука" });
    expect(res.status).toBe(400);
  });
});

// Отдельный describe — реальная сборка плана приглашённым должна начислить
// награду ОБЕИМ сторонам (см. referrals.js) — тут нужен замоканный вызов к
// Telegram (уведомление пригласившему), поэтому не в "HTTP-сервер" выше, тот
// же приём, что и у /api/pay/create и /yookassa/webhook: стаб fetch
// разделяет api.telegram.org (подменяется) и baseUrl (настоящий fetch).
describe("POST /api/plan — начисление реферальной награды по факту сборки плана", () => {
  let db, server, baseUrl;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    vi.stubGlobal("fetch", vi.fn((url, opts) => (String(url).includes("api.telegram.org") ? Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) }) : realFetch(url, opts))));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });

  it("приглашённый собирает первый план -> и он, и пригласивший получают Pro", async () => {
    await fetch(`${baseUrl}/api/referral/claim`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(2), referrerTelegramId: 1 }),
    });

    const res = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(2), timezoneOffsetMinutes: 180, mealSlots: [validSlot] }),
    });
    expect(res.status).toBe(200);

    const soon = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    expect(getUserPro(db, 1, soon)).toBe(true); // пригласивший
    expect(getUserPro(db, 2, soon)).toBe(true); // приглашённый
  });

  it("без ожидающего реферала — сборка плана работает как обычно, никому Pro не начисляется", async () => {
    const res = await fetch(`${baseUrl}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), timezoneOffsetMinutes: 180, mealSlots: [validSlot] }),
    });
    expect(res.status).toBe(200);
    expect(getUserPro(db, 42, new Date().toISOString())).toBe(false);
  });
});

// Отдельный describe — не в "HTTP-сервер" выше — потому что этому маршруту
// внутри нужен ЖИВОЙ (замоканный) внешний вызов к ВкусВилл (см.
// vkusvillPrices.js), а не только к нашему же тестовому серверу. Стаб fetch
// разделяет два адресата по URL: запрос к mcp.vkusvill.ru подменяется, всё
// остальное (включая собственный вызов теста к baseUrl) идёт настоящим
// fetch — иначе пришлось бы городить реальный HTTP для одного и подменять
// для другого через два разных клиента.
describe("POST /api/prices", () => {
  let db, server, baseUrl;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });

  function stubVkusvillFetch(mockImpl) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url, opts) => (String(url).includes("mcp.vkusvill.ru") ? mockImpl(url, opts) : realFetch(url, opts)))
    );
  }

  it("с валидной initData резолвит цены и кэширует их для следующего запроса", async () => {
    stubVkusvillFetch(async () => ({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ text: JSON.stringify({ ok: true, data: { items: [{ xml_id: "1", name: "Лук репчатый", price: { current: 58 }, unit: "кг" }] } }) }] },
      }),
    }));

    const res = await fetch(`${baseUrl}/api/prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), names: ["Лук"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prices).toEqual([{ name: "Лук", matched: true, price: 58, productUnit: "кг", xmlId: "1", packageAmount: null, packageUnit: null }]);

    // второй запрос с теми же именами — должен взять из кэша, без нового обращения к ВкусВилл
    const calls = fetch.mock.calls.length;
    const res2 = await fetch(`${baseUrl}/api/prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), names: ["Лук"] }),
    });
    expect(res2.status).toBe(200);
    const vkusvillCallsAfter = fetch.mock.calls.filter(([u]) => String(u).includes("mcp.vkusvill.ru")).length;
    const vkusvillCallsBefore = fetch.mock.calls.slice(0, calls).filter(([u]) => String(u).includes("mcp.vkusvill.ru")).length;
    expect(vkusvillCallsAfter).toBe(vkusvillCallsBefore); // ни одного нового живого вызова к ВкусВилл
  });

  it("без initData -> 401", async () => {
    const res = await fetch(`${baseUrl}/api/prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: ["Лук"] }),
    });
    expect(res.status).toBe(401);
  });

  it("с валидной initData, но без names -> 400", async () => {
    const res = await fetch(`${baseUrl}/api/prices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    expect(res.status).toBe(400);
  });
});

const YOOKASSA_CREDS = { shopId: "1460694", secretKey: "test_secret" };

describe("POST /api/pay/create", () => {
  let db, server, baseUrl;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    db = openDb(":memory:");
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });

  function stubYookassaFetch(mockImpl) {
    vi.stubGlobal("fetch", vi.fn((url, opts) => (String(url).includes("api.yookassa.ru") ? mockImpl(url, opts) : realFetch(url, opts))));
  }
  async function startServer(config) {
    server = createApp(db, config);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  it("создаёт платёж в ЮKassa, сохраняет pending-запись и возвращает confirmationUrl", async () => {
    await startServer({ botToken: BOT_TOKEN, yookassa: YOOKASSA_CREDS });
    stubYookassaFetch(async () => ({
      ok: true,
      json: async () => ({ id: "pay-1", status: "pending", confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay-1" } }),
    }));

    const res = await fetch(`${baseUrl}/api/pay/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), email: "user@example.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, confirmationUrl: "https://yookassa.ru/checkout/pay-1" });

    const payment = getPaymentByYookassaId(db, "pay-1");
    expect(payment).toMatchObject({ telegram_user_id: 42, amount_rub: 299, status: "pending" });
  });

  it("без initData -> 401, платёж не создаётся", async () => {
    await startServer({ botToken: BOT_TOKEN, yookassa: YOOKASSA_CREDS });
    const res = await fetch(`${baseUrl}/api/pay/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(401);
  });

  it("ЮKassa не настроена (yookassa не передан в конфиг) -> 503", async () => {
    await startServer({ botToken: BOT_TOKEN });
    const res = await fetch(`${baseUrl}/api/pay/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), email: "user@example.com" }),
    });
    expect(res.status).toBe(503);
  });

  // Регрессия на живую жалобу "ЮKassa createPayment: Receipt is missing or
  // illegal" — магазин требует чек с контактом покупателя на каждый платёж
  // (54-ФЗ). Отсекаем отсутствующий/некорректный email ДО похода к ЮKassa —
  // понятная ошибка сразу, а не невнятный отказ платёжного провайдера.
  it("без email -> 400, платёж не создаётся, к ЮKassa не ходим", async () => {
    await startServer({ botToken: BOT_TOKEN, yookassa: YOOKASSA_CREDS });
    const yookassaFetch = vi.fn();
    stubYookassaFetch(yookassaFetch);

    const res = await fetch(`${baseUrl}/api/pay/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    expect(res.status).toBe(400);
    expect(yookassaFetch).not.toHaveBeenCalled();
  });

  // Живой вывод из ревью: "разовая дешёвая покупка ещё одного плана на этой
  // неделе" — второй product у того же эндпоинта, дешевле и не тарифный.
  it("product:'extra_plan' -> платёж на EXTRA_PLAN_PRICE_RUB, а не на цену Pro", async () => {
    await startServer({ botToken: BOT_TOKEN, yookassa: YOOKASSA_CREDS });
    let capturedBody;
    stubYookassaFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ id: "pay-extra-1", status: "pending", confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay-extra-1" } }) };
    });

    const res = await fetch(`${baseUrl}/api/pay/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), email: "user@example.com", product: "extra_plan" }),
    });
    expect(res.status).toBe(200);
    expect(capturedBody.amount.value).toBe(EXTRA_PLAN_PRICE_RUB.toFixed(2));
    expect(capturedBody.amount.value).not.toBe(PRO_PRICE_RUB.toFixed(2));

    const payment = getPaymentByYookassaId(db, "pay-extra-1");
    expect(payment).toMatchObject({ telegram_user_id: 42, amount_rub: EXTRA_PLAN_PRICE_RUB, product: "extra_plan" });
  });

  it("product не передан -> как раньше, product:'pro' в записи платежа", async () => {
    await startServer({ botToken: BOT_TOKEN, yookassa: YOOKASSA_CREDS });
    stubYookassaFetch(async () => ({
      ok: true,
      json: async () => ({ id: "pay-default", status: "pending", confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay-default" } }),
    }));
    await fetch(`${baseUrl}/api/pay/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), email: "user@example.com" }),
    });
    expect(getPaymentByYookassaId(db, "pay-default")).toMatchObject({ product: "pro" });
  });

  it("email не похож на email (нет @/домена) -> 400", async () => {
    await startServer({ botToken: BOT_TOKEN, yookassa: YOOKASSA_CREDS });
    const res = await fetch(`${baseUrl}/api/pay/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), email: "не-email" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /yookassa/webhook", () => {
  let db, server, baseUrl;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN, yookassa: YOOKASSA_CREDS });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });

  function stubYookassaFetch(mockImpl) {
    vi.stubGlobal("fetch", vi.fn((url, opts) => (String(url).includes("api.yookassa.ru") ? mockImpl(url, opts) : realFetch(url, opts))));
  }

  it("succeeded (ПЕРЕПРОВЕРЕННЫЙ у ЮKassa, не из тела запроса) -> продлевает Pro и помечает платёж", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: "2026-09-10T09:00:00.000Z" });
    stubYookassaFetch(async () => ({
      ok: true,
      json: async () => ({ id: "pay-1", status: "succeeded", paid: true, amount: { value: "299.00" }, metadata: { telegram_user_id: "42" } }),
    }));

    // Тело запроса намеренно врёт про статус ("canceled") — сервер обязан
    // перепроверить у ЮKassa напрямую и довериться ТОЛЬКО этому, не телу.
    const res = await fetch(`${baseUrl}/yookassa/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "payment.succeeded", object: { id: "pay-1", status: "canceled" } }),
    });
    expect(res.status).toBe(200);

    expect(getPaymentByYookassaId(db, "pay-1")).toMatchObject({ status: "succeeded" });
    expect(getUserPro(db, 42, "2026-09-10T09:00:01.000Z")).toBe(true);
  });

  // Живой вывод из ревью: "разовая покупка ещё одного плана" — succeeded по
  // платежу с product:'extra_plan' должен начислить кредит, а НЕ продлить Pro.
  it("succeeded с product:'extra_plan' -> начисляет кредит, НЕ делает пользователя Pro", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-extra-1", telegramUserId: 42, amountRub: EXTRA_PLAN_PRICE_RUB, createdAtISO: "2026-09-10T09:00:00.000Z", product: "extra_plan" });
    stubYookassaFetch(async () => ({
      ok: true,
      json: async () => ({ id: "pay-extra-1", status: "succeeded", paid: true, amount: { value: `${EXTRA_PLAN_PRICE_RUB}.00` }, metadata: { telegram_user_id: "42" } }),
    }));

    const res = await fetch(`${baseUrl}/yookassa/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: "pay-extra-1" } }),
    });
    expect(res.status).toBe(200);
    expect(getPaymentByYookassaId(db, "pay-extra-1")).toMatchObject({ status: "succeeded" });
    expect(getExtraPlanCredits(db, 42)).toBe(1);
    expect(getUserPro(db, 42, "2026-09-10T09:00:01.000Z")).toBe(false);
  });

  it("повторное уведомление об УЖЕ succeeded платеже не продлевает Pro второй раз", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: "2026-09-10T09:00:00.000Z" });
    stubYookassaFetch(async () => ({
      ok: true,
      json: async () => ({ id: "pay-1", status: "succeeded", paid: true, amount: { value: "299.00" }, metadata: { telegram_user_id: "42" } }),
    }));

    await fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: "pay-1" } }) });
    const firstUntil = getPaymentByYookassaId(db, "pay-1");

    await fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: "pay-1" } }) });
    const secondUntil = getPaymentByYookassaId(db, "pay-1");

    expect(secondUntil.confirmed_at).toBe(firstUntil.confirmed_at); // не перезаписано вторым уведомлением
  });

  it("платёж, о котором мы не просили (нет pending-записи) -> 200, ничего не меняет", async () => {
    stubYookassaFetch(async () => ({
      ok: true,
      json: async () => ({ id: "unknown-pay", status: "succeeded", paid: true, amount: { value: "299.00" }, metadata: { telegram_user_id: "999" } }),
    }));
    const res = await fetch(`${baseUrl}/yookassa/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: "unknown-pay" } }),
    });
    expect(res.status).toBe(200);
    expect(getUserPro(db, 999, "2026-09-10T09:00:00.000Z")).toBe(false);
  });

  it("битое тело (без object.id) -> 400", async () => {
    const res = await fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("ЮKassa API недоступна при перепроверке -> 500 (чтобы ЮKassa повторила уведомление позже)", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: "2026-09-10T09:00:00.000Z" });
    stubYookassaFetch(async () => ({ ok: false, json: async () => ({ code: "internal_server_error" }) }));
    const res = await fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: "pay-1" } }) });
    expect(res.status).toBe(500);
  });
});

describe("POST /telegram/webhook", () => {
  const WEBHOOK_SECRET = "test-webhook-secret";
  // Захвачен на этапе регистрации describe (до того, как любой beforeEach/it
  // успел что-то застабить) — настоящий fetch, нужен ниже, чтобы обращения
  // к НАШЕМУ тестовому серверу (post()) шли по-настоящему, пока мокается
  // только то, что сервер сам шлёт в api.telegram.org — оба используют один
  // и тот же globalThis.fetch в одном процессе, отличить их можно только по URL.
  const realFetch = globalThis.fetch;
  let db, server, baseUrl, telegramCalls;

  function stubTelegramFetch(telegramResponse = { ok: true, json: async () => ({ ok: true, result: {} }) }) {
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (typeof url === "string" && url.includes("api.telegram.org")) {
        telegramCalls.push([url, opts]);
        return Promise.resolve(telegramResponse);
      }
      return realFetch(url, opts);
    }));
  }

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN, adminTelegramId: 777, webhookSecret: WEBHOOK_SECRET });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    telegramCalls = [];
    stubTelegramFetch();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (body, secret = WEBHOOK_SECRET) =>
    realFetch(`${baseUrl}/telegram/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(body),
    });

  it("без верного секрета в заголовке -> 401, ничего не отправляет", async () => {
    const res = await post({ message: { text: "/start", chat: { id: 42 } } }, "wrong-secret");
    expect(res.status).toBe(401);
    expect(telegramCalls).toHaveLength(0);
  });

  it("/start -> отвечает приветствием тому же chat_id", async () => {
    const res = await post({ message: { text: "/start", chat: { id: 42 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(1);
    const [url, opts] = telegramCalls[0];
    expect(url).toContain("/sendMessage");
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.chat_id).toBe(42);
    expect(sentBody.text).toContain("Съедим");
  });

  it("/report от админа -> шлёт дайджест (не sendMessage напрямую, а через sendDigestNow)", async () => {
    const res = await post({ message: { text: "/report", chat: { id: 777 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(1);
    const sentBody = JSON.parse(telegramCalls[0][1].body);
    expect(sentBody.chat_id).toBe(777);
  });

  it("/report от чужого chat_id -> 200, но ничего не отправляет (не палим статистику кому попало)", async () => {
    const res = await post({ message: { text: "/report", chat: { id: 999 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(0);
  });

  // Регрессия на жалобу в чате: "/report пишет 'событий не было', хотя
  // другой пользователь час назад собирал план" — /report раньше сам
  // обновлял last_digest_at при каждом вызове, поэтому ПЕРВАЯ же ручная
  // проверка "съедала" окно у второй — событие, случившееся ДО первого
  // /report, честно попадало в первый отчёт, но повторный /report чуть
  // позже уже не видел его снова (окно сдвинулось на момент первой
  // проверки). /report — это "посмотреть", а не "отметить прочитанным";
  // должен видеть одно и то же событие сколько угодно раз подряд, пока не
  // сработает настоящий ежедневный автотик.
  it("два подряд /report видят одно и то же старое событие — второй вызов не сдвигает окно первого", async () => {
    insertEvent(db, { telegramUserId: 42, eventName: "plan_generated", props: null, createdAtISO: new Date(Date.now() - 3600_000).toISOString() });

    const first = await post({ message: { text: "/report", chat: { id: 777 } } });
    expect(first.status).toBe(200);
    const second = await post({ message: { text: "/report", chat: { id: 777 } } });
    expect(second.status).toBe(200);

    expect(telegramCalls).toHaveLength(2);
    const firstText = JSON.parse(telegramCalls[0][1].body).text;
    const secondText = JSON.parse(telegramCalls[1][1].body).text;
    expect(firstText).toContain("планов собрано");
    expect(secondText).toContain("планов собрано"); // не "Событий не было" во второй раз
  });

  it("произвольное сообщение от пользователя -> сохраняет как обращение, шлёт благодарность пользователю и пуш админу", async () => {
    const res = await post({ message: { text: "Не находит цены на творог", chat: { id: 42 }, from: { id: 42 } } });
    expect(res.status).toBe(200);
    // Живая жалоба "не доходят сообщения в поддержку" — раньше обращение
    // только оседало в БД, узнать о нём можно было только вручную запросив
    // /feedback. Теперь помимо благодарности пользователю (chat 42) есть
    // ВТОРОЕ сообщение — пуш админу (chat 777) с текстом обращения сразу же.
    expect(telegramCalls).toHaveLength(2);
    const ackBody = JSON.parse(telegramCalls[0][1].body);
    expect(ackBody.chat_id).toBe(42);
    const adminNotifyBody = JSON.parse(telegramCalls[1][1].body);
    expect(adminNotifyBody.chat_id).toBe(777);
    expect(adminNotifyBody.text).toContain("Не находит цены на творог");
    expect(adminNotifyBody.text).toContain("42"); // telegram_user_id обратившегося — видно, кому отвечать

    const feedback = listRecentFeedback(db);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ telegramUserId: 42, text: "Не находит цены на творог" });
  });

  it("произвольное сообщение от пользователя, когда админ не настроен (adminTelegramId=null) -> сохраняет и отвечает, без второго сообщения", async () => {
    const noAdminServer = createApp(db, { botToken: BOT_TOKEN, adminTelegramId: null, webhookSecret: WEBHOOK_SECRET });
    await new Promise((resolve) => noAdminServer.listen(0, resolve));
    const noAdminBaseUrl = `http://127.0.0.1:${noAdminServer.address().port}`;
    try {
      const res = await realFetch(`${noAdminBaseUrl}/telegram/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET },
        body: JSON.stringify({ message: { text: "Сообщение без админа", chat: { id: 43 }, from: { id: 43 } } }),
      });
      expect(res.status).toBe(200);
      expect(telegramCalls).toHaveLength(1); // только ack пользователю, некому пушить
    } finally {
      await new Promise((resolve) => noAdminServer.close(resolve));
    }
  });

  it("произвольное сообщение от самого админа -> 200, не сохраняется как обращение", async () => {
    const res = await post({ message: { text: "тестовое сообщение", chat: { id: 777 }, from: { id: 777 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(0);
    expect(listRecentFeedback(db)).toHaveLength(0);
  });

  it("/feedback от админа -> присылает накопленные обращения", async () => {
    await post({ message: { text: "Долго грузится план", chat: { id: 42 }, from: { id: 42 } } });
    telegramCalls.length = 0; // сбросить — интересует только вызов /feedback ниже

    const res = await post({ message: { text: "/feedback", chat: { id: 777 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(1);
    const sentBody = JSON.parse(telegramCalls[0][1].body);
    expect(sentBody.chat_id).toBe(777);
    expect(sentBody.text).toContain("Долго грузится план");
  });

  it("/feedback от НЕ админа -> 200, ничего не отправляет", async () => {
    const res = await post({ message: { text: "/feedback", chat: { id: 999 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(0);
  });

  it("/backup от админа -> присылает файл БД документом", async () => {
    const res = await post({ message: { text: "/backup", chat: { id: 777 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(1);
    const [url, opts] = telegramCalls[0];
    expect(url).toContain("/sendDocument");
    expect(opts.body.get("chat_id")).toBe("777");
    expect(opts.body.get("document").name).toMatch(/\.db$/);
  });

  it("/backup от НЕ админа -> 200, ничего не отправляет", async () => {
    const res = await post({ message: { text: "/backup", chat: { id: 999 } } });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(0);
  });

  // Просьба в чате: "когда пользователь переходил в бота по кнопке
  // 'написать в поддержку', ему должно высвечиваться, что напишите сейчас
  // это обращение" — фронтенд (sendSupportPrompt в lib/backend.js) зовёт этот
  // эндпоинт ПЕРЕД закрытием Mini App.
  it("POST /api/support/prompt с валидной initData -> шлёт подсказку тому же telegram_user_id", async () => {
    const res = await realFetch(`${baseUrl}/api/support/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    expect(res.status).toBe(200);
    expect(telegramCalls).toHaveLength(1);
    const sentBody = JSON.parse(telegramCalls[0][1].body);
    expect(sentBody.chat_id).toBe(42);
    expect(sentBody.text).toMatch(/напишите/i);
  });

  it("POST /api/support/prompt без initData -> 401, ничего не отправляет", async () => {
    const res = await realFetch(`${baseUrl}/api/support/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(telegramCalls).toHaveLength(0);
  });

  it("всегда отвечает 200, даже если отправка ответа в Telegram не удалась (не хотим дублей от ретрая Telegram)", async () => {
    stubTelegramFetch({ ok: true, json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }) });
    const res = await post({ message: { text: "/start", chat: { id: 42 } } });
    expect(res.status).toBe(200);
  });
});
