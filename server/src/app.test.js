import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { openDb, findCandidateSlots, summarizeEventsSince, setUserPro, insertEvent, recordPlanGeneration, listPlanHistory, listRecentFeedback, createPendingPayment, getPaymentByYookassaId, getUserPro, getExtraPlanCredits, addExtraPlanCredit, extendUserPro, getProUntil } from "./db.js";
import { createApp, parsePlanRequest, parseEventRequest, parseSavePlanRequest, parseMealTimesRequest, parsePricesRequest, computePlanStatus, FREE_PLANS_PER_WEEK, EXTRA_PLAN_PRODUCT, EXTRA_PLAN_PRICE_RUB, PRO_PRICE_RUB, RATE_LIMIT_MAX_REQUESTS, PRICES_RATE_LIMIT_MAX_REQUESTS, PAY_RATE_LIMIT_MAX_REQUESTS, EVENTS_PER_USER_PER_DAY } from "./app.js";
import { clearRateLimitState } from "./rateLimit.js";
import { clearReconcileState } from "./payments.js";

const BOT_TOKEN = "123456:TEST-TOKEN";

// rateLimit.js хранит счётчики в module-level Map, общей на ВСЕ тесты этого
// файла (vitest переиспользует один и тот же модуль между it() внутри одного
// файла) — многие тесты ниже используют одного и того же telegram_user_id
// (validInitData(42)) помногу раз. Без сброса между тестами количество
// вызовов накапливалось бы через границы отдельных it() и рано или поздно
// начало бы ловить 429 там, где тест проверяет совсем другое поведение.
beforeEach(() => {
  clearRateLimitState();
});

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
  // неделе" — extraPlanCredits это ОСТАТОК кредитов прямо сейчас (не то, что
  // складывается с usedThisWeek — см. комментарий у computePlanStatus).
  it("extraPlanCredits открывает доступ сверх базового лимита", () => {
    const status = computePlanStatus(false, FREE_PLANS_PER_WEEK, new Date("2026-09-10T09:00:00Z"), 1);
    expect(status.canGenerate).toBe(true);
    expect(status.extraPlanCredits).toBe(1);
  });

  it("extraPlanCredits закончились (0) — снова заблокировано", () => {
    const status = computePlanStatus(false, FREE_PLANS_PER_WEEK, new Date("2026-09-10T09:00:00Z"), 0);
    expect(status.canGenerate).toBe(false);
  });

  // Регрессия на баг из тех. аудита #2: usedThisWeek считает ТОЛЬКО
  // бесплатные сборки (event_name='plan_generated'), сборки за счёт кредита
  // пишутся отдельным именем и сюда не попадают (см. /api/plan/generate) —
  // поэтому вторая покупка кредита в ту же неделю корректно открывает доступ,
  // даже если usedThisWeek уже "старше" FREE_PLANS_PER_WEEK не бывает по
  // построению, но функция не должна ломаться и на большем значении.
  it("usedThisWeek больше лимита, но credits>0 — всё равно можно (кредит независим)", () => {
    const status = computePlanStatus(false, FREE_PLANS_PER_WEEK + 1, new Date("2026-09-10T09:00:00Z"), 1);
    expect(status.canGenerate).toBe(true);
  });

  // UX-аудит 29.09.2026: дата сброса должна быть от самой сборки (окно
  // скользящее), а не "сейчас + 7 дней".
  it("nextResetHint считается от времени блокирующей сборки, а не от now", () => {
    const status = computePlanStatus(false, 1, new Date("2026-09-14T09:00:00Z"), 0, ["2026-09-10T18:30:00.000Z"]);
    expect(status.nextResetHint).toBe("2026-09-17T18:30:00.000Z");
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
      body: JSON.stringify({ initData: validInitData(42), eventName: "support_clicked", props: { step: 5 } }),
    });
    expect(res.status).toBe(200);
    const summary = summarizeEventsSince(db, "2020-01-01T00:00:00Z");
    expect(summary.totalEvents).toBe(1);
    expect(summary.byName[0].event_name).toBe("support_clicked");
  });

  it("POST /events без initData -> 401, ничего не сохраняется", async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventName: "support_clicked" }),
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

  // plan_generated теперь зарезервировано за сервером (см. /api/plan ниже) —
  // раньше это был единственный сигнал "план собран", и клиент мог просто не
  // отправить его, получая бесплатные планы без ограничения. Если это имя всё
  // же приходит на /events (старая закэшированная версия фронтенда) — тихо
  // игнорируем, а не пишем и не считаем ошибкой.
  it("POST /events с eventName=plan_generated игнорируется — не пишется, лимит не трогается", async () => {
    const res = await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42), eventName: "plan_generated" }),
    });
    expect(res.status).toBe(200);
    expect(summarizeEventsSince(db, "2020-01-01T00:00:00Z").totalEvents).toBe(0);
  });

  it("другие события не трогают extra_plan_credits", async () => {
    addExtraPlanCredit(db, 42, 1);
    await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), eventName: "support_clicked" }) });
    expect(getExtraPlanCredits(db, 42)).toBe(1);
  });

  // POST /api/plan — ТОЛЬКО синхронизация meal_slots для напоминаний (см.
  // комментарий у неё в app.js). Регрессия на баг LIMIT_MISCOUNT (тех. и
  // UX-аудит 29.09.2026): раньше именно этот вызов списывал лимит/кредит на
  // КАЖДОЕ открытие приложения с сохранённым планом или замену блюда — теперь
  // он не должен трогать лимит и кредиты вообще, сколько бы раз его ни звать.
  const planSyncRequest = (telegramId = 42) => fetch(`${baseUrl}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: validInitData(telegramId), timezoneOffsetMinutes: 180, mealSlots: [validSlot] }),
  });

  it("POST /api/plan (синхронизация) не пишет plan_generated и не списывает кредиты, сколько раз ни вызови", async () => {
    addExtraPlanCredit(db, 42, 2);
    for (let i = 0; i < 5; i++) {
      expect((await planSyncRequest()).status).toBe(200);
    }
    expect(getExtraPlanCredits(db, 42)).toBe(2);
    const summary = summarizeEventsSince(db, "2020-01-01T00:00:00Z");
    expect(summary.byName.find((r) => r.event_name === "plan_generated")).toBeUndefined();
  });

  // POST /api/plan/generate — авторитетный учёт бесплатного лимита. Вызывается
  // ровно один раз на реальную сборку (см. reportPlanGenerated в backend.js).
  const generateRequest = (telegramId = 42) => fetch(`${baseUrl}/api/plan/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: validInitData(telegramId) }),
  });

  it("POST /api/plan/generate: первая сборка — в пределах базового лимита, source:free, кредит не трогаем", async () => {
    addExtraPlanCredit(db, 42, 2);
    const res = await generateRequest();
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe("free");
    expect(getExtraPlanCredits(db, 42)).toBe(2);
  });

  it("POST /api/plan/generate: вторая сборка на той же неделе — за счёт кредита, source:credit", async () => {
    addExtraPlanCredit(db, 42, 2);
    await generateRequest();
    const res = await generateRequest();
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe("credit");
    expect(getExtraPlanCredits(db, 42)).toBe(1);
  });

  // Журнал plan_generations — источник правды для лимита: аналитику (events) чистят по
  // сроку, режут потолком и удаляют с аккаунтом, а право на бесплатный план от этого не зависит.
  it("лимит не зависит от аналитики: очистка/потеря events не открывает новый бесплатный план", async () => {
    await generateRequest(); // бесплатная
    db.exec("DELETE FROM events"); // например, уборка по сроку или удаление событий
    const res = await generateRequest();
    expect(res.status).toBe(403);
    const rows = db.prepare("SELECT source FROM plan_generations WHERE telegram_user_id = 42").all();
    expect(rows.map((r) => r.source)).toEqual(["free"]);
  });

  it("каждая сборка пишется в журнал со своим источником (free, credit, pro) и в аналитику", async () => {
    addExtraPlanCredit(db, 42, 1);
    await generateRequest(); // free
    await generateRequest(); // credit
    setUserPro(db, 42, true);
    await generateRequest(); // pro
    const sources = db.prepare("SELECT source FROM plan_generations WHERE telegram_user_id = 42 ORDER BY id").all().map((r) => r.source);
    expect(sources).toEqual(["free", "credit", "pro"]);
    const names = db.prepare("SELECT event_name FROM events WHERE telegram_user_id = 42 ORDER BY id").all().map((r) => r.event_name);
    expect(names).toEqual(["plan_generated", "plan_generated_credit", "plan_generated_pro"]);
  });

  it("клиентские события plan_generated_credit/pro через /events на лимит не влияют", async () => {
    for (const eventName of ["plan_generated_credit", "plan_generated_pro", "plan_generated"]) {
      await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), eventName }) });
    }
    expect((await generateRequest()).status).toBe(200); // слот по-прежнему свободен
    expect(db.prepare("SELECT COUNT(*) c FROM plan_generations WHERE telegram_user_id = 42").get().c).toBe(1);
  });

  it("POST /api/plan/generate: лимит и кредиты исчерпаны -> 403", async () => {
    await generateRequest(); // бесплатная
    const second = await generateRequest(); // без кредитов
    expect(second.status).toBe(403);
    const body = await second.json();
    expect(body.ok).toBe(false);
  });

  it("POST /api/plan/generate: Pro-пользователь никогда не расходует extra_plan_credits", async () => {
    setUserPro(db, 42, true);
    addExtraPlanCredit(db, 42, 1);
    for (let i = 0; i < 3; i++) {
      const res = await generateRequest();
      expect(res.status).toBe(200);
      expect((await res.json()).source).toBe("pro");
    }
    expect(getExtraPlanCredits(db, 42)).toBe(1);
  });

  // Регрессия на баг из тех. аудита #2 (формула кредитов): купить кредит →
  // использовать → купить ВТОРОЙ кредит в ту же неделю → должен открыть
  // доступ. Раньше usedThisWeek считала уже потраченный кредит тоже, и вторая
  // покупка не помогала (usedThisWeek >= FREE_PLANS_PER_WEEK + credits).
  it("POST /api/plan/generate: вторая покупка кредита в ту же неделю ПОСЛЕ использования первого — снова можно", async () => {
    addExtraPlanCredit(db, 42, 1);
    await generateRequest(); // бесплатная (source:free)
    expect((await generateRequest()).status).toBe(200); // за счёт первого кредита (source:credit), credits -> 0

    addExtraPlanCredit(db, 42, 1); // купили ВТОРОЙ кредит в ту же неделю
    const res = await generateRequest();
    expect(res.status).toBe(200); // должно снова получиться — раньше здесь был 403
    expect((await res.json()).source).toBe("credit");
    expect(getExtraPlanCredits(db, 42)).toBe(0);
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
    recordPlanGeneration(db, { telegramUserId: 42, source: "free", createdAtISO: new Date().toISOString() });
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
    recordPlanGeneration(db, { telegramUserId: 42, source: "free", createdAtISO: new Date().toISOString() });
    const res = await fetch(`${baseUrl}/api/plan-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: validInitData(42) }),
    });
    const data = await res.json();
    expect(data).toMatchObject({ isPro: true, canGenerate: true });
  });

  // UX-аудит 29.09.2026: напоминание бота отправляло продлевать Pro на
  // кнопку, которой у действующего Pro не было — нужен срок окончания.
  it("POST /api/plan-status: оплаченный Pro отдаёт proUntil, у free он null", async () => {
    const status = async (id) => (await fetch(`${baseUrl}/api/plan-status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(id) }),
    })).json();
    expect((await status(42)).proUntil).toBeNull();
    extendUserPro(db, 43, { fromISO: new Date().toISOString(), addDays: 30 });
    const paid = await status(43);
    expect(paid.isPro).toBe(true);
    expect(paid.proUntil).toBeTruthy();
  });

  it("POST /api/plan-status: у бывшего Pro есть proEndedAt (для кнопки «Продлить»), у действующего и у новичка — null", async () => {
    const status = async (id) => (await fetch(`${baseUrl}/api/plan-status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(id) }),
    })).json();
    expect((await status(50)).proEndedAt).toBeNull();
    extendUserPro(db, 51, { fromISO: new Date().toISOString(), addDays: 30 });
    expect((await status(51)).proEndedAt).toBeNull();
    const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    extendUserPro(db, 52, { fromISO: longAgo, addDays: 30 }); // закончился 10 дней назад
    const ended = await status(52);
    expect(ended.isPro).toBe(false);
    expect(ended.proUntil).toBeNull();
    expect(ended.proEndedAt).toBeTruthy();
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
describe("Реферальная награда — по факту РЕАЛЬНОЙ сборки (POST /api/plan/generate)", () => {
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
  const post = (path, id, body = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(id), ...body }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const claim = (referred, referrer) => post("/api/referral/claim", referred, { referrerTelegramId: referrer });
  const generate = (id) => post("/api/plan/generate", id);
  const sync = (id) => post("/api/plan", id, { timezoneOffsetMinutes: 180, mealSlots: [validSlot] });
  const proUntil = (id) => db.prepare("SELECT pro_until FROM users WHERE telegram_user_id = ?").get(id)?.pro_until ?? null;
  const soon = () => new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();

  it("приглашённый собирает первый план -> и он, и пригласивший получают Pro", async () => {
    await claim(2, 1);
    expect((await generate(2)).status).toBe(200);
    expect(getUserPro(db, 1, soon())).toBe(true); // пригласивший
    expect(getUserPro(db, 2, soon())).toBe(true); // приглашённый
  });

  it("простая синхронизация плана (/api/plan) награды НЕ начисляет — только реальная сборка", async () => {
    await claim(2, 1);
    await sync(2);
    expect(getUserPro(db, 1, soon())).toBe(false);
    expect(getUserPro(db, 2, soon())).toBe(false);
  });

  it("без ожидающего реферала — сборка работает как обычно, никому Pro не начисляется", async () => {
    expect((await generate(42)).status).toBe(200);
    expect(getUserPro(db, 42, new Date().toISOString())).toBe(false);
  });

  // Перепроверка аудита 04.10.2026, раздел 3: "заявка -> сборка -> удалить данные
  // -> снова заявка" давала пригласившему +7 дней Pro на каждом круге, а лимит
  // приглашённого обнулялся вместе с событиями.
  describe("удаление аккаунта не обнуляет рефералы и лимит", () => {
    it("повторная заявка после удаления отклоняется, у пригласившего Pro не растёт", async () => {
      await claim(2, 1);
      await generate(2);
      const afterFirst = proUntil(1);
      expect(afterFirst).not.toBeNull();

      for (let round = 0; round < 3; round++) {
        await post("/api/account/delete", 2, { confirm: true });
        const again = await claim(2, 1);
        expect(again.body.claimed).toBe(false);
        await sync(2);
        await generate(2);
      }
      expect(proUntil(1)).toBe(afterFirst);
    });

    it("потолок наград пригласившего не обнуляется удалением аккаунтов приглашённых", async () => {
      for (let i = 0; i < MAX_REWARDED_REFERRALS_FOR_TEST; i++) {
        const invited = 100 + i;
        await claim(invited, 1);
        await generate(invited);
        await post("/api/account/delete", invited, { confirm: true }); // строки referrals приглашённого удалены
      }
      const before = proUntil(1);
      await claim(999, 1);
      await generate(999);
      expect(proUntil(1)).toBe(before); // потолок достигнут, несмотря на удаления
    });

    it("бесплатный лимит не сбрасывается удалением: сборка до удаления считается в окне", async () => {
      expect((await generate(2)).status).toBe(200);
      await post("/api/account/delete", 2, { confirm: true });
      const status = (await post("/api/plan-status", 2)).body;
      expect(status.canGenerate).toBe(false);
      expect(status.usedThisWeek).toBe(1);
      expect(status.nextResetHint).toBeTruthy();
      expect((await generate(2)).status).toBe(403);
    });

    it("удалил аккаунт, не использовав лимит — лимит свободен как раньше", async () => {
      await post("/api/plan-status", 2);
      await post("/api/account/delete", 2, { confirm: true });
      expect((await post("/api/plan-status", 2)).body.canGenerate).toBe(true);
    });
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

  // telegramCalls — тела запросов к api.telegram.org (подтверждение оплаты
  // пользователю); telegramOk=false имитирует сбой Telegram (бот заблокирован).
  let telegramCalls, telegramOk;
  beforeEach(() => { telegramCalls = []; telegramOk = true; });
  function stubYookassaFetch(mockImpl) {
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("api.yookassa.ru")) return mockImpl(url, opts);
      if (String(url).includes("api.telegram.org")) {
        telegramCalls.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, json: async () => (telegramOk ? { ok: true, result: {} } : { ok: false, description: "Forbidden: bot was blocked by the user" }) });
      }
      return realFetch(url, opts);
    }));
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

    // UX-аудит 29.09.2026: после оплаты пользователь получает подтверждение
    // в чате с кнопкой, открывающей Mini App.
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].chat_id).toBe(42);
    expect(telegramCalls[0].text).toContain("Оплата прошла");
    expect(telegramCalls[0].text).toContain("Pro активен");
    expect(telegramCalls[0].reply_markup.inline_keyboard[0][0].web_app.url).toMatch(/^https:\/\//);
  });

  it("сбой Telegram при отправке подтверждения НЕ ломает уже проведённую оплату (200, Pro продлён)", async () => {
    telegramOk = false;
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: "2026-09-10T09:00:00.000Z" });
    stubYookassaFetch(async () => ({
      ok: true,
      json: async () => ({ id: "pay-1", status: "succeeded", paid: true, amount: { value: "299.00" }, metadata: { telegram_user_id: "42" } }),
    }));
    const res = await fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: "pay-1" } }) });
    expect(res.status).toBe(200);
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
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].text).toContain("ещё один план");
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
    expect(telegramCalls).toHaveLength(1); // подтверждение уходит один раз, не на каждое повторное уведомление
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

// Живой вывод из ревью безопасности (чат): "стоит сделать rate limiting" —
// см. server/src/rateLimit.js за самим механизмом, здесь — что он реально
// подключён к нужным эндпоинтам и с правильными порогами.
describe("Rate limiting", () => {
  let db, server, baseUrl;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN, yookassa: { shopId: "1460694", secretKey: "test_secret" } });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });

  it(`общий лимит (${RATE_LIMIT_MAX_REQUESTS}/мин): дальше 429, до этого — обычные ответы`, async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      const res = await fetch(`${baseUrl}/api/plan-status`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(1) }),
      });
      expect(res.status).toBe(200);
    }
    const overLimit = await fetch(`${baseUrl}/api/plan-status`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(1) }),
    });
    expect(overLimit.status).toBe(429);
  });

  it("общий лимит считается отдельно по каждому telegram_user_id, не глобально", async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      await fetch(`${baseUrl}/api/plan-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(1) }) });
    }
    // другой пользователь — свежий счётчик, не задет чужим лимитом
    const otherUser = await fetch(`${baseUrl}/api/plan-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(2) }) });
    expect(otherUser.status).toBe(200);
  });

  it("/api/plan и /events (мимо readAuthenticatedBody) тоже считаются в общий лимит — общий на все эндпоинты сразу", async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      await fetch(`${baseUrl}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(3), eventName: "app_opened" }) });
    }
    const res = await fetch(`${baseUrl}/api/plan-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(3) }) });
    expect(res.status).toBe(429);
  });

  it(`/api/prices: отдельный более строгий лимит (${PRICES_RATE_LIMIT_MAX_REQUESTS}/мин) поверх общего`, async () => {
    // Без подмены тест ходил в настоящий ВкусВилл и зависел от его настроения
    // (быстрый отказ -> каждый из запросов снова живой -> секунды и таймаут).
    vi.stubGlobal("fetch", vi.fn((url, opts) => (String(url).includes("mcp.vkusvill.ru")
      ? Promise.resolve({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: true, data: { items: [{ xml_id: "1", name: "Лук", price: { current: 50 }, unit: "кг" }] } }) }] } }) })
      : realFetch(url, opts))));
    for (let i = 0; i < PRICES_RATE_LIMIT_MAX_REQUESTS; i++) {
      const res = await fetch(`${baseUrl}/api/prices`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(4), names: ["Лук"] }),
      });
      expect(res.status).toBe(200);
    }
    const overLimit = await fetch(`${baseUrl}/api/prices`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(4), names: ["Лук"] }),
    });
    expect(overLimit.status).toBe(429);
  });

  it(`/api/pay/create: отдельный более строгий лимит (${PAY_RATE_LIMIT_MAX_REQUESTS}/мин) поверх общего`, async () => {
    // Без email — падает на 400 ДО создания реального платежа, но лимит
    // считается ещё раньше (сразу после авторизации), поэтому подходит для
    // теста и не требует мокать саму ЮKassa.
    for (let i = 0; i < PAY_RATE_LIMIT_MAX_REQUESTS; i++) {
      const res = await fetch(`${baseUrl}/api/pay/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(5) }) });
      expect(res.status).toBe(400); // нет email — но это ПОСЛЕ прохождения лимита
    }
    const overLimit = await fetch(`${baseUrl}/api/pay/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(5) }) });
    expect(overLimit.status).toBe(429);
  });

  it("/yookassa/webhook: публичный эндпоинт без initData тоже ограничен, по IP", async () => {
    vi.stubGlobal("fetch", vi.fn((url, opts) => (String(url).includes("api.yookassa.ru")
      ? Promise.resolve({ ok: true, json: async () => ({ id: "unknown", status: "canceled", paid: false, amount: { value: "1.00" }, metadata: {} }) })
      : realFetch(url, opts))));

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      const res = await fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: `pay-${i}` } }) });
      expect(res.status).toBe(200);
    }
    const overLimit = await fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ object: { id: "pay-over" } }) });
    expect(overLimit.status).toBe(429);
  });

  it("429 отдаёт понятное сообщение об ошибке, не голый статус", async () => {
    vi.stubGlobal("fetch", vi.fn((url, opts) => (String(url).includes("mcp.vkusvill.ru")
      ? Promise.resolve({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [{ text: JSON.stringify({ ok: true, data: { items: [{ xml_id: "1", name: "Лук", price: { current: 50 }, unit: "кг" }] } }) }] } }) })
      : realFetch(url, opts))));
    for (let i = 0; i < PRICES_RATE_LIMIT_MAX_REQUESTS; i++) {
      await fetch(`${baseUrl}/api/prices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(6), names: ["Лук"] }) });
    }
    const res = await fetch(`${baseUrl}/api/prices`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(6), names: ["Лук"] }) });
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: expect.stringMatching(/слишком много запросов/i) });
  });
});


// ---------- Аудит 29.09.2026: платежи, защита диска, удаление, тело запроса ----------

describe("Платежи: возвраты, чужие события, сверка, двойной тап", () => {
  let db, server, baseUrl, telegramCalls, yookassaCalls, yookassaPayment;
  const realFetch = globalThis.fetch;
  const ADMIN = 777;

  beforeEach(async () => {
    db = openDb(":memory:");
    telegramCalls = [];
    yookassaCalls = [];
    yookassaPayment = null;
    server = createApp(db, { botToken: BOT_TOKEN, adminTelegramId: ADMIN, yookassa: YOOKASSA_CREDS });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("api.yookassa.ru")) {
        yookassaCalls.push({ url: String(url), opts });
        return Promise.resolve({ ok: true, json: async () => yookassaPayment });
      }
      if (String(url).includes("api.telegram.org")) {
        telegramCalls.push(JSON.parse(opts.body));
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) });
      }
      return realFetch(url, opts);
    }));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });

  const webhook = (body) => fetch(`${baseUrl}/yookassa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const planStatus = (id = 42) => fetch(`${baseUrl}/api/plan-status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(id) }) }).then((r) => r.json());
  const payment = (over = {}) => ({ id: "pay-1", status: "succeeded", paid: true, amount: { value: "299.00" }, metadata: { telegram_user_id: "42" }, ...over });

  it("refund.succeeded: платёж берётся из object.payment_id, возврат подтверждается у ЮKassa, Pro снимается, админ получает алерт", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: new Date().toISOString() });
    yookassaPayment = payment();
    await webhook({ event: "payment.succeeded", object: { id: "pay-1" } });
    expect(getUserPro(db, 42, new Date(Date.now() + 1000).toISOString())).toBe(true);

    yookassaPayment = payment({ refunded_amount: { value: "299.00", currency: "RUB" } });
    // У возврата свой id (refund-9), платёж — в payment_id. Раньше брали object.id и ловили 404 -> 500 -> бесконечные повторы.
    const res = await webhook({ event: "refund.succeeded", object: { id: "refund-9", payment_id: "pay-1", status: "succeeded" } });
    expect(res.status).toBe(200);
    expect(yookassaCalls.at(-1).url).toContain("/payments/pay-1");
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("refunded");
    expect(getUserPro(db, 42, new Date(Date.now() + 1000).toISOString())).toBe(false);
    expect(telegramCalls.some((c) => c.chat_id === ADMIN && c.text.includes("Возврат"))).toBe(true);
  });

  it("поддельное refund.succeeded без настоящего возврата у ЮKassa ничего не снимает", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: new Date().toISOString() });
    yookassaPayment = payment();
    await webhook({ object: { id: "pay-1" } });
    // тело врёт, у ЮKassa refunded_amount нет
    await webhook({ event: "refund.succeeded", object: { id: "fake", payment_id: "pay-1" } });
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("succeeded");
    expect(getUserPro(db, 42, new Date(Date.now() + 1000).toISOString())).toBe(true);
  });

  it("события других семейств (payout.*) -> 200, в ЮKassa не ходим вообще", async () => {
    const res = await webhook({ event: "payout.succeeded", object: { id: "x" } });
    expect(res.status).toBe(200);
    expect(yookassaCalls).toHaveLength(0);
  });

  it("refund.* без payment_id -> 400", async () => {
    expect((await webhook({ event: "refund.succeeded", object: { id: "refund-9" } })).status).toBe(400);
  });

  it("платёж не из нашей базы -> 200 и алерт админу (раньше молча терялся)", async () => {
    yookassaPayment = payment({ id: "stranger", metadata: { telegram_user_id: "555" } });
    const res = await webhook({ object: { id: "stranger" } });
    expect(res.status).toBe(200);
    expect(telegramCalls.some((c) => c.chat_id === ADMIN && c.text.includes("нет в базе"))).toBe(true);
  });

  it("сумма в ЮKassa не совпала с нашей -> Pro НЕ выдаётся, статус review, алерт админу", async () => {
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: new Date().toISOString() });
    yookassaPayment = payment({ amount: { value: "1.00" } });
    await webhook({ object: { id: "pay-1" } });
    expect(getUserPro(db, 42, new Date(Date.now() + 1000).toISOString())).toBe(false);
    expect(getPaymentByYookassaId(db, "pay-1").status).toBe("review");
    expect(telegramCalls.some((c) => c.chat_id === ADMIN && c.text.includes("сумма"))).toBe(true);
  });

  it("/api/plan-status сам сверяет зависший платёж пользователя: вебхук не пришёл, а оплаченное уже выдано", async () => {
    clearReconcileState();
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 42, amountRub: 299, createdAtISO: new Date().toISOString() });
    yookassaPayment = payment();
    const status = await planStatus(42);
    expect(status.isPro).toBe(true);
    expect(telegramCalls.some((c) => c.chat_id === 42 && c.text.includes("Оплата прошла"))).toBe(true);
  });

  it("/api/plan-status не сверяет чужие платежи", async () => {
    clearReconcileState();
    createPendingPayment(db, { yookassaPaymentId: "pay-1", telegramUserId: 43, amountRub: 299, createdAtISO: new Date().toISOString() });
    yookassaPayment = payment({ metadata: { telegram_user_id: "43" } });
    await planStatus(42);
    expect(yookassaCalls).toHaveLength(0);
  });

  it("ключ вернул УЖЕ отменённый платёж (ссылка мёртвая) -> один повтор с другим ключом, в базе живой платёж", async () => {
    let n = 0;
    const responses = [
      { id: "pay-dead", status: "canceled", confirmation: null },
      { id: "pay-live", status: "pending", confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay-live" } },
    ];
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("api.yookassa.ru")) { yookassaCalls.push({ url: String(url), opts }); return Promise.resolve({ ok: true, json: async () => responses[Math.min(n++, 1)] }); }
      if (String(url).includes("api.telegram.org")) return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) });
      return realFetch(url, opts);
    }));
    const res = await fetch(`${baseUrl}/api/pay/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), email: "a@b.ru" }) });
    expect((await res.json()).confirmationUrl).toContain("pay-live");
    const keys = yookassaCalls.filter((c) => c.opts?.method === "POST").map((c) => c.opts.headers["Idempotence-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(getPaymentByYookassaId(db, "pay-live")).not.toBeNull();
  });

  it("/api/plan-status не ждёт медленную ЮKassa дольше ~3,5 с: отвечает, а оплаченное выдаётся и уведомляется в фоне", async () => {
    clearReconcileState();
    createPendingPayment(db, { yookassaPaymentId: "pay-slow", telegramUserId: 42, amountRub: 299, createdAtISO: new Date().toISOString() });
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("api.yookassa.ru")) return new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => payment({ id: "pay-slow" }) }), 5000));
      if (String(url).includes("api.telegram.org")) { telegramCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) }); }
      return realFetch(url, opts);
    }));
    const startedAt = Date.now();
    const status = await planStatus(42);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(4500);
    expect(status.isPro).toBe(false); // ответ ушёл до окончания сверки
    await new Promise((resolve) => setTimeout(resolve, 2000)); // фон доделывает
    expect(getUserPro(db, 42, new Date(Date.now() + 1000).toISOString())).toBe(true);
    expect(telegramCalls.some((c) => c.chat_id === 42 && c.text.includes("Оплата прошла"))).toBe(true);
  }, 15000);

  it("двойной тап по «Оплатить»: тот же Idempotence-Key, одна запись в payments, оба запроса 200", async () => {
    yookassaPayment = { id: "pay-new", status: "pending", confirmation: { confirmation_url: "https://yookassa.ru/checkout/pay-new" } };
    const pay = () => fetch(`${baseUrl}/api/pay/create`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(42), email: "a@b.ru" }) });
    const [r1, r2] = [await pay(), await pay()];
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const keys = yookassaCalls.filter((c) => c.opts?.method === "POST").map((c) => c.opts.headers["Idempotence-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM payments").get().c).toBe(1);
  });
});

describe("Защита диска и размеры запросов", () => {
  let db, server, baseUrl;
  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));
  const post = (path, body) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("/events: props крупнее 600 байт отклоняются", async () => {
    const res = await post("/events", { initData: validInitData(42), eventName: "x", props: { message: "я".repeat(700) } });
    expect(res.status).toBe(400);
  });

  it("/events: обычное app_error (300 символов) проходит", async () => {
    const res = await post("/events", { initData: validInitData(42), eventName: "app_error", props: { message: "я".repeat(300), source: "window.onerror" } });
    expect(res.status).toBe(200);
  });

  it(`/events: после ${EVENTS_PER_USER_PER_DAY} событий за сутки пользователю -> 429, другой пользователь не затронут`, async () => {
    const nowISO = new Date().toISOString();
    db.exec("BEGIN");
    for (let i = 0; i < EVENTS_PER_USER_PER_DAY; i++) insertEvent(db, { telegramUserId: 42, eventName: "spam", props: null, createdAtISO: nowISO });
    db.exec("COMMIT");
    expect((await post("/events", { initData: validInitData(42), eventName: "x" })).status).toBe(429);
    expect((await post("/events", { initData: validInitData(43), eventName: "x" })).status).toBe(200);
  });

  it("/events: события старше суток не считаются в дневной потолок", async () => {
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    db.exec("BEGIN");
    for (let i = 0; i < EVENTS_PER_USER_PER_DAY; i++) insertEvent(db, { telegramUserId: 42, eventName: "old", props: null, createdAtISO: old });
    db.exec("COMMIT");
    expect((await post("/events", { initData: validInitData(42), eventName: "x" })).status).toBe(200);
  });

  it("/api/prices: название длиннее 80 символов отклоняется", async () => {
    const res = await post("/api/prices", { initData: validInitData(42), names: ["ю".repeat(81)] });
    expect(res.status).toBe(400);
  });

  it("слишком большое тело запроса -> 400 (раньше запрос подвисал навсегда)", async () => {
    const res = await post("/api/plans", { initData: validInitData(42), junk: "x".repeat(1_100_000) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/слишком большое/);
  }, 15000);

  // Регрессия на баг из аудита (приложение B): тело, разрезанное сетевыми
  // кусками посреди кириллической буквы, портилось ("�") при конкатенации строк.
  it("кириллица на границе двух сетевых кусков сохраняется без искажений", async () => {
    const note = "Жук в Щавеле";
    const body = Buffer.from(JSON.stringify({ initData: validInitData(42), storeId: "vv", storeName: "ВкусВилл", budget: 3000, family: 2, totalCost: 2500, plan: { note } }));
    const splitAt = body.indexOf(Buffer.from("Ж")) + 1; // ровно между двумя байтами буквы "Ж"
    await new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port: server.address().port, path: "/api/plans", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": body.length } },
        (res) => { res.resume(); res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`)))); }
      );
      req.on("error", reject);
      req.write(body.subarray(0, splitAt));
      setTimeout(() => { req.write(body.subarray(splitAt)); req.end(); }, 60);
    });
    expect(listPlanHistory(db, 42)[0].plan.note).toBe(note);
  });
});

describe("POST /api/account/delete (право на удаление)", () => {
  let db, server, baseUrl;
  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));
  const del = (body) => fetch(`${baseUrl}/api/account/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("без confirm:true ничего не удаляет (защита от случайного вызова)", async () => {
    insertEvent(db, { telegramUserId: 42, eventName: "x", props: null, createdAtISO: new Date().toISOString() });
    expect((await del({ initData: validInitData(42) })).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS c FROM events WHERE telegram_user_id = 42").get().c).toBe(1);
  });

  it("без initData -> 401", async () => {
    expect((await del({ confirm: true })).status).toBe(401);
  });

  it("удаляет данные ТОЛЬКО авторизованного пользователя, платежи остаются", async () => {
    const nowISO = new Date().toISOString();
    for (const id of [42, 43]) {
      insertEvent(db, { telegramUserId: id, eventName: "x", props: null, createdAtISO: nowISO });
      listPlanHistory(db, id);
    }
    createPendingPayment(db, { yookassaPaymentId: "pay-42", telegramUserId: 42, amountRub: 299, createdAtISO: nowISO });
    const res = await del({ initData: validInitData(42), confirm: true });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS c FROM events WHERE telegram_user_id = 42").get().c).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM events WHERE telegram_user_id = 43").get().c).toBe(1);
    expect(getPaymentByYookassaId(db, "pay-42")).not.toBeNull();
  });
});

// Решение автора (30.09.2026): семья не остаётся после окончания Pro у
// владельца — общий список перестаёт работать, данные сохраняются.
describe("Семья и Pro владельца", () => {
  let db, server, baseUrl;
  beforeEach(async () => {
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));
  const post = (path, id, body = {}) => fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(id), ...body }) }).then(async (r) => ({ status: r.status, body: await r.json() }));

  async function familyWithMember() {
    setUserPro(db, 1, true);
    const created = await post("/api/family/create", 1);
    await post("/api/family/join", 2, { inviteCode: created.body.status.inviteCode });
    return created.body.status.inviteCode;
  }

  it("пока у владельца Pro: семья активна, общий список работает", async () => {
    await familyWithMember();
    expect((await post("/api/family/pantry", 2, { name: "Молоко", present: true })).status).toBe(200);
    const status = await post("/api/family/status", 2);
    expect(status.body.status).toMatchObject({ inFamily: true, active: true, pantryNames: ["Молоко"] });
  });

  it("у владельца закончился Pro: семья неактивна у ВСЕХ, список пуст, отметить нельзя", async () => {
    await familyWithMember();
    await post("/api/family/pantry", 2, { name: "Молоко", present: true });
    setUserPro(db, 1, false);

    for (const id of [1, 2]) {
      const status = (await post("/api/family/status", id)).body.status;
      expect(status).toMatchObject({ inFamily: true, active: false, pantryNames: [] });
    }
    const toggle = await post("/api/family/pantry", 2, { name: "Хлеб", present: true });
    expect(toggle.status).toBe(403);
    expect(toggle.body.error).toMatch(/неактивна/);
  });

  it("новый человек не может вступить в семью с истёкшим Pro у владельца", async () => {
    const code = await familyWithMember();
    setUserPro(db, 1, false);
    const join = await post("/api/family/join", 3, { inviteCode: code });
    expect(join.status).toBe(400);
    expect(join.body.error).toMatch(/закончился Pro/);
  });

  it("владелец продлил Pro — семья снова активна с теми же данными", async () => {
    await familyWithMember();
    await post("/api/family/pantry", 2, { name: "Молоко", present: true });
    setUserPro(db, 1, false);
    setUserPro(db, 1, true);
    const status = (await post("/api/family/status", 2)).body.status;
    expect(status).toMatchObject({ active: true, pantryNames: ["Молоко"] });
    expect(status.members).toHaveLength(2);
  });

  it("участник и сам без Pro — семья работает, пока Pro у владельца", async () => {
    await familyWithMember();
    expect(getUserPro(db, 2, new Date().toISOString())).toBe(false);
    expect((await post("/api/family/pantry", 2, { name: "Сыр", present: true })).status).toBe(200);
  });
});

// ---------- Прокси каталога ВкусВилл и диагностика (CORS-preflight 04.10.2026) ----------
import { clearProxyState } from "./vkusvillProxy.js";
import { MAX_REWARDED_REFERRALS } from "./referrals.js";
const MAX_REWARDED_REFERRALS_FOR_TEST = MAX_REWARDED_REFERRALS;
import { resetUpstreamGate } from "./vkusvillPrices.js";

describe("POST /api/vkusvill/call — прокси каталога", () => {
  let db, server, baseUrl, mcpCalls, mcpImpl;
  const realFetch = globalThis.fetch;
  const mcpOk = (data) => ({ ok: true, json: async () => ({ result: { content: [{ text: JSON.stringify({ ok: true, data }) }] } }) });

  beforeEach(async () => {
    clearProxyState();
    resetUpstreamGate();
    mcpCalls = [];
    mcpImpl = async () => mcpOk({ items: [{ id: 1 }] });
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("mcp.vkusvill.ru")) { mcpCalls.push(JSON.parse(opts.body)); return mcpImpl(); }
      return realFetch(url, opts);
    }));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });
  const call = (body, id = 42) => fetch(`${baseUrl}/api/vkusvill/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ initData: validInitData(id), ...body }) });

  it("без initData -> 401, во ВкусВилл не ходит", async () => {
    const res = await fetch(`${baseUrl}/api/vkusvill/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "vkusvill_recipes", args: {} }) });
    expect(res.status).toBe(401);
    expect(mcpCalls).toHaveLength(0);
  });

  it("неизвестный инструмент -> 400 (это не открытый прокси)", async () => {
    expect((await call({ tool: "evil_tool", args: {} })).status).toBe(400);
    expect(mcpCalls).toHaveLength(0);
  });

  it("успех: данные из ответа ВкусВилл, имя инструмента и аргументы передаются как есть", async () => {
    const res = await call({ tool: "vkusvill_products_search", args: { q: "молоко", page: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { items: [{ id: 1 }] } });
    expect(mcpCalls[0].params).toEqual({ name: "vkusvill_products_search", arguments: { q: "молоко", page: 1 } });
  });

  it("второй такой же запрос (даже от другого пользователя) — из общего кэша", async () => {
    await call({ tool: "vkusvill_recipes", args: { page: 1 } }, 42);
    await call({ tool: "vkusvill_recipes", args: { page: 1 } }, 43);
    expect(mcpCalls).toHaveLength(1);
  });

  it("ВкусВилл ответил ошибкой -> 502 с кодом upstreamStatus (повторять фронтенду нет смысла)", async () => {
    mcpImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const res = await call({ tool: "vkusvill_recipes", args: { page: 9 } });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, upstreamStatus: 403 });
  });

  it("корзина: от 1 до 20 позиций, ссылка создаётся сервером", async () => {
    expect((await call({ tool: "vkusvill_cart_link_create", args: { products: [] } })).status).toBe(400);
    mcpImpl = async () => mcpOk({ links: ["https://vkusvill.ru/cart/x"] });
    const res = await call({ tool: "vkusvill_cart_link_create", args: { products: [{ xml_id: 1, q: 2 }] } });
    expect((await res.json()).data.links[0]).toContain("vkusvill.ru");
  });
});

describe("/diag в боте (только админ)", () => {
  let db, server, baseUrl, telegramCalls, mcpResponse;
  const realFetch = globalThis.fetch;
  const SECRET = "diag-secret";
  const ADMIN = 777;

  beforeEach(async () => {
    resetUpstreamGate();
    telegramCalls = [];
    mcpResponse = { ok: true, json: async () => ({ result: { content: [{ text: JSON.stringify({ ok: true, data: { items: [{ id: 1 }] } }) }] } }) };
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN, adminTelegramId: ADMIN, webhookSecret: SECRET });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("mcp.vkusvill.ru")) return Promise.resolve(mcpResponse);
      if (String(url).includes("api.telegram.org")) { telegramCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) }); }
      return realFetch(url, opts);
    }));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });
  const send = (chatId, text) => fetch(`${baseUrl}/telegram/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ message: { chat: { id: chatId }, from: { id: chatId }, text } }),
  });

  it("админ получает вердикт: ВкусВилл с сервера отвечает", async () => {
    await send(ADMIN, "/diag");
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].chat_id).toBe(ADMIN);
    expect(telegramCalls[0].text).toContain("отвечает");
  });

  it("если ВкусВилл блокирует сервер — вердикт с HTTP-кодом и подсказкой про хостинг в РФ", async () => {
    mcpResponse = { ok: false, status: 403, json: async () => ({}) };
    await send(ADMIN, "/diag");
    expect(telegramCalls[0].text).toContain("НЕ отвечает");
    expect(telegramCalls[0].text).toContain("403");
    expect(telegramCalls[0].text).toContain("РФ");
  });

  it("обычный пользователь /diag не получает ничего и ничего не запускает", async () => {
    await send(555, "/diag");
    expect(telegramCalls.filter((c) => c.text?.includes("ВкусВилл"))).toHaveLength(0);
  });
});

describe("Скриншот в поддержку через бота", () => {
  let db, server, baseUrl, telegramCalls;
  const realFetch = globalThis.fetch;
  const SECRET = "photo-secret";
  const ADMIN = 777;

  beforeEach(async () => {
    telegramCalls = [];
    db = openDb(":memory:");
    server = createApp(db, { botToken: BOT_TOKEN, adminTelegramId: ADMIN, webhookSecret: SECRET });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("api.telegram.org")) {
        telegramCalls.push({ method: String(url).split("/").pop(), body: JSON.parse(opts.body) });
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) });
      }
      return realFetch(url, opts);
    }));
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    vi.unstubAllGlobals();
  });
  const send = (message) => fetch(`${baseUrl}/telegram/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ message }),
  });

  it("фото с подписью: обращение сохранено, пользователю ack, админу — текст и КОПИЯ самого сообщения", async () => {
    const res = await send({ message_id: 55, chat: { id: 42 }, from: { id: 42 }, photo: [{ file_id: "x" }], caption: "ошибка при сборке плана" });
    expect(res.status).toBe(200);
    expect(listRecentFeedback(db)[0].text).toBe("📎 скриншот: ошибка при сборке плана");

    const methods = telegramCalls.map((c) => `${c.method}:${c.body.chat_id}`);
    expect(methods).toContain("sendMessage:42"); // ack пользователю
    expect(methods).toContain(`sendMessage:${ADMIN}`); // текст админу
    const copy = telegramCalls.find((c) => c.method === "copyMessage");
    expect(copy.body).toEqual({ chat_id: ADMIN, from_chat_id: 42, message_id: 55 });
  });

  it("сбой копирования скриншота не ломает приём обращения", async () => {
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).endsWith("/copyMessage")) return Promise.resolve({ ok: false, status: 400, json: async () => ({ ok: false, description: "message to copy not found" }) });
      if (String(url).includes("api.telegram.org")) return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: {} }) });
      return realFetch(url, opts);
    }));
    const res = await send({ message_id: 56, chat: { id: 42 }, from: { id: 42 }, photo: [{ file_id: "x" }] });
    expect(res.status).toBe(200);
    expect(listRecentFeedback(db)).toHaveLength(1);
  });

  it("обычный текст без вложения — копирования нет", async () => {
    await send({ message_id: 57, chat: { id: 42 }, from: { id: 42 }, text: "не работает" });
    expect(telegramCalls.some((c) => c.method === "copyMessage")).toBe(false);
  });
});
