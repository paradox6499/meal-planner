// HTTP-обработчики, отдельно от самого запуска сервера (index.js) — так
// createApp(db, config) можно вызвать в тесте с in-memory БД и настоящим
// http-запросом через supertest-подобный fetch к тестовому серверу, без
// поднятия реального процесса на реальном порту.
import { createServer } from "node:http";
import { validateInitData } from "./initData.js";
import { saveUserPlan } from "./db.js";

const MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // грубая защита от гигантского тела запроса
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("невалидный JSON в теле запроса"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // Открыто для любого origin — фронтенд статический (GitHub Pages), нет
    // смысла жёстко прибивать домен, эндпоинт и так защищён проверкой
    // initData, а не CORS-политикой (CORS вообще не про это, это gate для
    // браузера, не для сервера).
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

/** Валидирует и нормализует тело POST /api/plan в форму, готовую для
 * saveUserPlan — вынесено отдельно от HTTP-обвязки, чтобы тестировать без
 * реального запроса. */
export function parsePlanRequest(body, telegramUserId) {
  const { timezoneOffsetMinutes, reminderLeadMinutes, mealSlots } = body;
  if (typeof timezoneOffsetMinutes !== "number" || Math.abs(timezoneOffsetMinutes) > 14 * 60) {
    return { ok: false, error: "timezoneOffsetMinutes отсутствует или вне разумного диапазона" };
  }
  if (!Array.isArray(mealSlots) || mealSlots.length === 0) {
    return { ok: false, error: "mealSlots пуст или отсутствует" };
  }
  for (const slot of mealSlots) {
    if (!MEAL_TYPES.has(slot.mealType)) return { ok: false, error: `неизвестный mealType: ${slot.mealType}` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.scheduledDate)) return { ok: false, error: `неверный формат scheduledDate: ${slot.scheduledDate}` };
    if (!/^\d{2}:\d{2}$/.test(slot.mealTime)) return { ok: false, error: `неверный формат mealTime: ${slot.mealTime}` };
    if (!slot.recipeName || typeof slot.recipeName !== "string") return { ok: false, error: "recipeName отсутствует" };
    if (!slot.mealLabel || typeof slot.mealLabel !== "string") return { ok: false, error: "mealLabel отсутствует" };
  }
  return {
    ok: true,
    value: {
      telegramUserId,
      timezoneOffsetMinutes,
      reminderLeadMinutes: typeof reminderLeadMinutes === "number" ? reminderLeadMinutes : 30,
      mealSlots,
    },
  };
}

export function createApp(db, { botToken }) {
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === "/api/plan") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }

      const auth = validateInitData(body.initData, botToken);
      if (!auth.ok) {
        sendJson(res, 401, { ok: false, error: auth.error });
        return;
      }

      const parsed = parsePlanRequest(body, auth.user.id);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error });
        return;
      }

      try {
        saveUserPlan(db, parsed.value);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("[api/plan] ошибка сохранения:", err);
        sendJson(res, 500, { ok: false, error: "не удалось сохранить план" });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });
}
