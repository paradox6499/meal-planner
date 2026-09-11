// HTTP-обработчики, отдельно от самого запуска сервера (index.js) — так
// createApp(db, config) можно вызвать в тесте с in-memory БД и настоящим
// http-запросом через supertest-подобный fetch к тестовому серверу, без
// поднятия реального процесса на реальном порту.
import { createServer } from "node:http";
import { validateInitData } from "./initData.js";
import {
  saveUserPlan, insertEvent,
  getUserPro, countPlanGenerationsSince, savePlanHistory, listPlanHistory,
  saveFeedback, listRecentFeedback,
} from "./db.js";
import { planReplyForUpdate, buildWelcomeText, buildFeedbackAckText, buildFeedbackListText } from "./webhook.js";
import { sendTelegramMessage } from "./telegram.js";
import { sendDigestNow } from "./digest.js";

const MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);
const MAX_EVENT_NAME_LENGTH = 64;
// props — небольшой контекст к событию (например, шаг визарда или сообщение
// ошибки), не произвольная полезная нагрузка. Ограничение размера — не
// столько защита от злоупотребления (initData и так подписан Telegram-ом),
// сколько подстраховка от случайного "закинуть весь stack trace с
// кодом" из фронтенда.
const MAX_PROPS_JSON_LENGTH = 4000;
// "1 план в неделю" — тот же лимит, что уже честно анонсирован пользователям
// текстом в SUBSCRIPTION_BENEFITS (src/App.jsx) задолго до того, как он
// реально стал работать технически.
export const FREE_PLANS_PER_WEEK = 1;
const FREE_WINDOW_MS = 7 * 24 * 3_600_000;
const MAX_PLAN_JSON_LENGTH = 200_000; // с запасом на неделю рецептов+список покупок, но не резиновое

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

/** Аналогично parsePlanRequest — чистая функция валидации, отдельно от HTTP,
 * чтобы тестировать без реального запроса. */
export function parseEventRequest(body, telegramUserId) {
  const { eventName, props } = body;
  if (typeof eventName !== "string" || !eventName || eventName.length > MAX_EVENT_NAME_LENGTH) {
    return { ok: false, error: "eventName отсутствует или слишком длинный" };
  }
  if (props !== undefined && props !== null && (typeof props !== "object" || Array.isArray(props))) {
    return { ok: false, error: "props должен быть объектом" };
  }
  const propsJson = props ? JSON.stringify(props) : null;
  if (propsJson && propsJson.length > MAX_PROPS_JSON_LENGTH) {
    return { ok: false, error: "props слишком большой" };
  }
  return { ok: true, value: { telegramUserId, eventName, props: props ?? null } };
}

/** Общий для новых эндпоинтов кусок: прочитать JSON-тело и проверить
 * initData. Возвращает либо {ok:true, body, telegramUserId}, либо
 * {ok:false, status, error} — вызывающему коду остаётся только эта пара ifов
 * и своя собственная бизнес-валидация/логика. Старые /api/plan и /events
 * оставлены как есть (не рефакторил их под это) — риск задеть уже
 * протестированное ради чистоты кода того не стоит. */
async function readAuthenticatedBody(req, botToken) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return { ok: false, status: 400, error: err.message };
  }
  const auth = validateInitData(body.initData, botToken);
  if (!auth.ok) return { ok: false, status: 401, error: auth.error };
  return { ok: true, body, telegramUserId: auth.user.id };
}

/** Чистая функция — сколько ещё бесплатных сборок доступно прямо сейчас.
 * Вынесена отдельно от HTTP, чтобы тестировать без реального запроса и без
 * реальных дат (принимает now параметром). */
export function computePlanStatus(isPro, usedThisWeek, now) {
  const canGenerate = isPro || usedThisWeek < FREE_PLANS_PER_WEEK;
  return {
    isPro,
    freeLimitPerWeek: FREE_PLANS_PER_WEEK,
    usedThisWeek,
    canGenerate,
    // Не "через 7 дней от последнего плана", а просто "через 7 дней от
    // сейчас" — раз лимит скользящий (countPlanGenerationsSince), а не
    // календарная неделя, показывать пользователю смысла больше в простом
    // "загляните через неделю", чем в точной дате сброса конкретного слота.
    nextResetHint: canGenerate ? null : new Date(now.getTime() + FREE_WINDOW_MS).toISOString(),
  };
}

export function parseSavePlanRequest(body, telegramUserId) {
  const { storeId, storeName, budget, family, totalCost, plan } = body;
  if (!storeId || typeof storeId !== "string") return { ok: false, error: "storeId отсутствует" };
  if (!storeName || typeof storeName !== "string") return { ok: false, error: "storeName отсутствует" };
  if (typeof budget !== "number" || budget <= 0) return { ok: false, error: "budget отсутствует или некорректен" };
  if (typeof family !== "number" || family <= 0) return { ok: false, error: "family отсутствует или некорректен" };
  if (totalCost !== undefined && totalCost !== null && typeof totalCost !== "number") {
    return { ok: false, error: "totalCost должен быть числом" };
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { ok: false, error: "plan отсутствует" };
  const planJsonLength = JSON.stringify(plan).length;
  if (planJsonLength > MAX_PLAN_JSON_LENGTH) return { ok: false, error: "plan слишком большой" };
  return {
    ok: true,
    value: { telegramUserId, storeId, storeName, budget, family, totalCost: totalCost ?? null, plan },
  };
}

export function createApp(db, { botToken, adminTelegramId = null, webhookSecret = null }) {
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

    if (req.method === "POST" && req.url === "/events") {
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

      const parsed = parseEventRequest(body, auth.user.id);
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error });
        return;
      }

      try {
        insertEvent(db, { ...parsed.value, createdAtISO: new Date().toISOString() });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("[events] ошибка сохранения:", err);
        sendJson(res, 500, { ok: false, error: "не удалось сохранить событие" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/plan-status") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      try {
        const isPro = getUserPro(db, auth.telegramUserId);
        const sinceISO = new Date(Date.now() - FREE_WINDOW_MS).toISOString();
        const usedThisWeek = countPlanGenerationsSince(db, auth.telegramUserId, sinceISO);
        sendJson(res, 200, { ok: true, ...computePlanStatus(isPro, usedThisWeek, new Date()) });
      } catch (err) {
        console.error("[api/plan-status] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось получить статус" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/plans") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      const parsed = parseSavePlanRequest(auth.body, auth.telegramUserId);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

      try {
        savePlanHistory(db, { ...parsed.value, createdAtISO: new Date().toISOString() });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("[api/plans] ошибка сохранения:", err);
        sendJson(res, 500, { ok: false, error: "не удалось сохранить план в историю" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/plans/list") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      try {
        sendJson(res, 200, { ok: true, plans: listPlanHistory(db, auth.telegramUserId) });
      } catch (err) {
        console.error("[api/plans/list] ошибка чтения:", err);
        sendJson(res, 500, { ok: false, error: "не удалось получить историю" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/telegram/webhook") {
      // Секрет, который Telegram кладёт в этот заголовок, ТОЛЬКО если он был
      // задан при регистрации вебхука (setWebhook, см. server/README.md) —
      // без проверки любой в интернете мог бы слать сюда поддельные апдейты,
      // например звать /report от имени админа, подделав chat.id. Без
      // заданного webhookSecret вообще — честно отклоняем всё, а не тихо
      // доверяем непроверенным запросам.
      if (!webhookSecret || req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
        sendJson(res, 401, { ok: false, error: "invalid webhook secret" });
        return;
      }
      let update;
      try {
        update = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }

      const reply = planReplyForUpdate(update, { adminTelegramId });
      try {
        if (reply?.kind === "start") {
          await sendTelegramMessage(botToken, reply.chatId, buildWelcomeText());
        } else if (reply?.kind === "report") {
          await sendDigestNow(db, { botToken, adminTelegramId });
        } else if (reply?.kind === "list_feedback") {
          await sendTelegramMessage(botToken, reply.chatId, buildFeedbackListText(listRecentFeedback(db)));
        } else if (reply?.kind === "feedback") {
          saveFeedback(db, { telegramUserId: reply.telegramUserId, text: reply.text, createdAtISO: new Date().toISOString() });
          await sendTelegramMessage(botToken, reply.chatId, buildFeedbackAckText());
        }
      } catch (err) {
        console.error("[telegram/webhook] не удалось ответить:", err.message);
      }
      // Telegram повторяет вебхук, если ответ не 200 — отвечаем 200 всегда,
      // даже если сама отправка ответа не удалась (залогировано выше), чтобы
      // не получить дубли одного и того же апдейта.
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });
}
