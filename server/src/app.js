// HTTP-обработчики, отдельно от самого запуска сервера (index.js) — так
// createApp(db, config) можно вызвать в тесте с in-memory БД и настоящим
// http-запросом через supertest-подобный fetch к тестовому серверу, без
// поднятия реального процесса на реальном порту.
import { createServer } from "node:http";
import { validateInitData } from "./initData.js";
import { randomUUID } from "node:crypto";
import {
  saveUserPlan, insertEvent,
  getUserPro, countPlanGenerationsSince, savePlanHistory, listPlanHistory,
  saveFeedback, listRecentFeedback, updateMealTimesForUser,
  createPendingPayment, getPaymentByYookassaId, updatePaymentStatus, extendUserPro,
  countRewardedReferrals,
  getExtraPlanCredits, addExtraPlanCredit, consumeExtraPlanCredit,
} from "./db.js";
import { planReplyForUpdate, buildWelcomeText, buildFeedbackAckText, buildFeedbackListText, buildFeedbackAdminNotifyText, buildSupportPromptText } from "./webhook.js";
import { sendTelegramMessage } from "./telegram.js";
import { sendDigestNow } from "./digest.js";
import { sendBackupNow } from "./backup.js";
import { resolveIngredientPricesWithCache } from "./vkusvillPrices.js";
import { createPayment, fetchPaymentStatus } from "./yookassa.js";
import { claimReferral, maybeRewardReferral, REFERRAL_REWARD_DAYS } from "./referrals.js";
import { createFamily, joinFamily, leaveFamily, getFamilyStatus, toggleFamilyPantryItem } from "./family.js";

const MEAL_TYPES = new Set(["breakfast", "lunch", "dinner", "snack"]);
const MAX_EVENT_NAME_LENGTH = 64;
// Разумный потолок на список названий ингредиентов за один запрос — целая
// неделя (3-4 приёма пищи × 7 дней) даёт от силы 60-100 УНИКАЛЬНЫХ названий
// (см. attachRealCosts в src/lib/vkusvillRecipes.js — как раз он и будет
// главным вызывающим). 300 — с большим запасом на будущее, без открытой
// двери для "прислать 100000 строк и утопить сервер в живых запросах к
// ВкусВилл на каждый промах кэша".
const MAX_INGREDIENT_NAMES = 300;
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
// export — scheduler.js переиспользует то же значение для "лёгкого
// бесплатного напоминания вернуться" (runFreeNudgeTick), чтобы окно сброса
// лимита не разъезжалось между двумя местами при будущей правке.
export const FREE_WINDOW_MS = 7 * 24 * 3_600_000;
const MAX_PLAN_JSON_LENGTH = 200_000; // с запасом на неделю рецептов+список покупок, но не резиновое

// Цена и срок — те же 299 ₽/мес, что уже показаны на ProModal (src/App.jsx)
// и в public/terms.html ("указанный на экране оплаты срок") задолго до того,
// как оплата реально заработала технически. 30 дней, не "календарный месяц" —
// проще и однозначнее (extendUserPro просто прибавляет дни, без вопроса
// "а как быть с февралём").
export const PRO_PRICE_RUB = 299;
export const PRO_PERIOD_DAYS = 30;

// "Ещё один план на этой неделе" — разовая дешёвая покупка, ступенька перед
// полной подпиской (живой вывод из ревью в чате: "многим проще заплатить
// один раз 50-70 ₽, чем сразу оформить месячную подписку"). Не отдельная
// таблица тарифов — просто второй "product" у того же /api/pay/create,
// см. parsePayCreateRequest и ветку в /yookassa/webhook.
export const EXTRA_PLAN_PRODUCT = "extra_plan";
export const EXTRA_PLAN_PRICE_RUB = 59;
const PRO_PRODUCT = "pro";

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
  // firstName — best-effort отображаемое имя (для /api/family/*: "кто есть в
  // семье"), не участвует в авторизации. Telegram не гарантирует его наличие
  // у каждого пользователя, поэтому не required нигде, где уже используется
  // readAuthenticatedBody.
  return { ok: true, body, telegramUserId: auth.user.id, firstName: auth.user.first_name ?? null };
}

/** Чистая функция — сколько ещё бесплатных сборок доступно прямо сейчас.
 * Вынесена отдельно от HTTP, чтобы тестировать без реального запроса и без
 * реальных дат (принимает now параметром). extraPlanCredits — разовые
 * покупки "ещё один план на этой неделе" (см. EXTRA_PLAN_PRODUCT) — просто
 * прибавляются к базовому бесплатному лимиту, списываются по факту
 * использования отдельно (см. /events ниже), не здесь. */
export function computePlanStatus(isPro, usedThisWeek, now, extraPlanCredits = 0) {
  const canGenerate = isPro || usedThisWeek < FREE_PLANS_PER_WEEK + extraPlanCredits;
  return {
    isPro,
    freeLimitPerWeek: FREE_PLANS_PER_WEEK,
    usedThisWeek,
    extraPlanCredits,
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

/** {mealTimes: {breakfast: "08:00", ...}} — не обязательно все 4 типа сразу,
 * только те, что реально поменялись. Отдельно от parseSavePlanRequest —
 * этот запрос не привязан к конкретному плану вообще, просто обновляет
 * время у уже сохранённых слотов (см. updateMealTimesForUser в db.js). */
export function parseMealTimesRequest(body, telegramUserId) {
  const { mealTimes } = body;
  if (!mealTimes || typeof mealTimes !== "object" || Array.isArray(mealTimes)) {
    return { ok: false, error: "mealTimes отсутствует" };
  }
  const entries = Object.entries(mealTimes);
  if (entries.length === 0) return { ok: false, error: "mealTimes пуст" };
  for (const [mealType, mealTime] of entries) {
    if (!MEAL_TYPES.has(mealType)) return { ok: false, error: `неизвестный mealType: ${mealType}` };
    if (!/^\d{2}:\d{2}$/.test(mealTime)) return { ok: false, error: `неверный формат времени для ${mealType}: ${mealTime}` };
  }
  return { ok: true, value: { telegramUserId, mealTimes } };
}

/** {names: string[]} — уникальные имена не требуются на входе (резолвер сам
 * дедуплицирует, см. vkusvillPrices.js), но пустые/не-строковые элементы
 * отклоняем сразу, а не тихо пропускаем — не тот код, где стоит гадать, что
 * имелось в виду. */
export function parsePricesRequest(body) {
  const { names } = body;
  if (!Array.isArray(names) || names.length === 0) return { ok: false, error: "names отсутствует или пуст" };
  if (names.length > MAX_INGREDIENT_NAMES) return { ok: false, error: `names слишком длинный (максимум ${MAX_INGREDIENT_NAMES})` };
  if (!names.every((n) => typeof n === "string" && n.trim().length > 0)) {
    return { ok: false, error: "names должен состоять из непустых строк" };
  }
  return { ok: true, value: { names } };
}

/** Достаёт id платежа из тела уведомления ЮKassa — и НИЧЕГО больше оттуда не
 * берёт на веру (см. комментарий у fetchPaymentStatus в yookassa.js: тело
 * вебхука не подписано, статус из него использовать для решений нельзя).
 * Форма реального уведомления: {event, object: {id, status, ...}}. */
export function parseYookassaWebhookBody(body) {
  const paymentId = body?.object?.id;
  if (!paymentId || typeof paymentId !== "string") return { ok: false, error: "object.id отсутствует" };
  return { ok: true, value: { paymentId } };
}

/** {referrerTelegramId: number} — сам referredTelegramId берётся из
 * initData (см. readAuthenticatedBody), не из тела: доверять чужому
 * заявлению "я — пользователь X" нельзя, а initData уже подписана Telegram. */
export function parseReferralClaimRequest(body) {
  const { referrerTelegramId } = body;
  if (typeof referrerTelegramId !== "number" || !Number.isFinite(referrerTelegramId)) {
    return { ok: false, error: "referrerTelegramId отсутствует или некорректен" };
  }
  return { ok: true, value: { referrerTelegramId } };
}

// Разумный потолок длины — genInviteCode в db.js генерирует 12 символов,
// с запасом на случай смены длины кода в будущем; не пропускаем что попало.
const MAX_FAMILY_INVITE_CODE_LENGTH = 64;

export function parseFamilyJoinRequest(body) {
  const { inviteCode } = body;
  if (typeof inviteCode !== "string" || !inviteCode.trim() || inviteCode.length > MAX_FAMILY_INVITE_CODE_LENGTH) {
    return { ok: false, error: "inviteCode отсутствует или некорректен" };
  }
  return { ok: true, value: { inviteCode: inviteCode.trim() } };
}

const MAX_FAMILY_PANTRY_NAME_LENGTH = 200; // тот же порядок, что MAX_EVENT_NAME_LENGTH — с запасом под любое реальное название ингредиента

export function parseFamilyPantryRequest(body) {
  const { name, present } = body;
  if (typeof name !== "string" || !name.trim() || name.length > MAX_FAMILY_PANTRY_NAME_LENGTH) {
    return { ok: false, error: "name отсутствует или некорректен" };
  }
  if (typeof present !== "boolean") {
    return { ok: false, error: "present должен быть true/false" };
  }
  return { ok: true, value: { name: name.trim(), present } };
}

export function createApp(db, { botToken, adminTelegramId = null, webhookSecret = null, yookassa = null }) {
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
        return;
      }
      // Реальная сборка плана — это и есть "приглашённый активировался" (см.
      // referrals.js) — если у него есть ожидающий реферал, начисляет
      // награду обеим сторонам. Идемпотентно (проверено внутри), безопасно
      // звать на каждую сборку, не только первую. Ответ 200 пользователю уже
      // ушёл выше — сбой здесь (например Telegram не даёт написать
      // пригласившему) не должен выглядеть как сбой сохранения плана.
      try {
        await maybeRewardReferral(db, auth.user.id, { botToken });
      } catch (err) {
        console.error("[api/plan] ошибка начисления реферальной награды:", err.message);
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
        // Та же дыра, что нашлась у /api/pay/create ("нажимаю — событий в
        // логе нет вообще"): отказ авторизации тут не логировался НИКАК —
        // если у кого-то из тестировавших initData не проходит проверку
        // (например, открыли не через кнопку бота, а по голой ссылке на
        // GitHub Pages в обычном браузере — тогда initData у Telegram просто
        // пустая строка), events молча отбрасывались, а /report потом
        // честно, но вводяще в заблуждение писал "Событий не было".
        console.warn(`[events] отказ авторизации (401):`, auth.error);
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
        // Списание разового кредита "ещё один план на этой неделе" (см.
        // EXTRA_PLAN_PRODUCT выше) — ровно в момент реального использования,
        // не в момент покупки. plan_generated — тот же analytics-сигнал,
        // которым уже считается usedThisWeek (countPlanGenerationsSince), так
        // что это событие И ЕСТЬ факт "план собран", а не отдельная догадка.
        // usedBefore считаем ДО только что вставленного события — вычитаем 1
        // из счётчика, который теперь уже включает его.
        if (parsed.value.eventName === "plan_generated" && !getUserPro(db, auth.user.id, new Date().toISOString())) {
          const sinceISO = new Date(Date.now() - FREE_WINDOW_MS).toISOString();
          const usedBefore = countPlanGenerationsSince(db, auth.user.id, sinceISO) - 1;
          if (usedBefore >= FREE_PLANS_PER_WEEK) consumeExtraPlanCredit(db, auth.user.id);
        }
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
        const isPro = getUserPro(db, auth.telegramUserId, new Date().toISOString());
        const sinceISO = new Date(Date.now() - FREE_WINDOW_MS).toISOString();
        const usedThisWeek = countPlanGenerationsSince(db, auth.telegramUserId, sinceISO);
        const extraPlanCredits = getExtraPlanCredits(db, auth.telegramUserId);
        sendJson(res, 200, { ok: true, ...computePlanStatus(isPro, usedThisWeek, new Date(), extraPlanCredits) });
      } catch (err) {
        console.error("[api/plan-status] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось получить статус" });
      }
      return;
    }

    // Просьба в чате: "когда пользователь переходил в бота по кнопке
    // 'написать в поддержку', ему должно высвечиваться, что напишите сейчас
    // это обращение и мы отправим его в поддержку". Кнопка в AccountView
    // закрывает Mini App (WebApp.close()), возвращая пользователя в пустой
    // чат с ботом — этот эндпоинт шлёт объясняющий текст ПЕРЕД закрытием,
    // чтобы пользователь увидел уже открытый чат с понятной подсказкой, а не
    // пустой экран, где неясно, что теперь просто написать сообщение.
    // telegram_user_id для личного чата с ботом совпадает с chat_id — тот же
    // принцип, что и у остальной адресной рассылки в этом файле (напоминания,
    // дайджест и т.п.), отдельного chat_id никто не передаёт.
    if (req.method === "POST" && req.url === "/api/support/prompt") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      try {
        await sendTelegramMessage(botToken, auth.telegramUserId, buildSupportPromptText());
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("[api/support/prompt] не удалось отправить:", err.message);
        sendJson(res, 500, { ok: false, error: "не удалось отправить" });
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

    if (req.method === "POST" && req.url === "/api/meal-times") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      const parsed = parseMealTimesRequest(auth.body, auth.telegramUserId);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

      try {
        const updated = updateMealTimesForUser(db, parsed.value.telegramUserId, parsed.value.mealTimes);
        sendJson(res, 200, { ok: true, updated });
      } catch (err) {
        console.error("[api/meal-times] ошибка обновления:", err);
        sendJson(res, 500, { ok: false, error: "не удалось обновить время приёмов пищи" });
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

    // Регистрирует "меня пригласил такой-то" — фронтенд зовёт это один раз
    // при открытии по реферальной ссылке (?startapp=ref_<id>), см.
    // referrals.js за всей логикой отказов (самоприглашение, уже
    // существующий пользователь, уже был приглашён кем-то другим). Все эти
    // отказы — не ошибка HTTP, а нормальный, ожидаемый исход бизнес-логики
    // (claimed:false), фронтенд их просто тихо игнорирует.
    if (req.method === "POST" && req.url === "/api/referral/claim") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      const parsed = parseReferralClaimRequest(auth.body);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

      try {
        const result = claimReferral(db, {
          referrerTelegramId: parsed.value.referrerTelegramId,
          referredTelegramId: auth.telegramUserId,
          nowISO: new Date().toISOString(),
        });
        sendJson(res, 200, { ok: true, claimed: result.ok, reason: result.ok ? undefined : result.reason });
      } catch (err) {
        console.error("[api/referral/claim] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось зарегистрировать реферала" });
      }
      return;
    }

    // Сколько человек пригласил этот пользователь (уже вознаграждённых) —
    // для отображения прогресса в Аккаунте, тот же принцип, что и у
    // streak/экономии на клиенте (planLogic.js:computeBudgetStreak): честно
    // показывать реальное состояние, не гадать.
    if (req.method === "POST" && req.url === "/api/referral/status") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      try {
        const rewardedCount = countRewardedReferrals(db, auth.telegramUserId);
        sendJson(res, 200, { ok: true, rewardedCount, daysEarned: rewardedCount * REFERRAL_REWARD_DAYS });
      } catch (err) {
        console.error("[api/referral/status] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось получить статус рефералов" });
      }
      return;
    }

    // "Общий список на семью" (Pro-бонус, см. family.js) — создать может
    // только Pro (проверка здесь, не в family.js — та же граница
    // ответственности, что и везде: бизнес-правила про саму семью в
    // family.js, "хватает ли тарифа" решает вызывающий HTTP-слой).
    if (req.method === "POST" && req.url === "/api/family/create") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      if (!getUserPro(db, auth.telegramUserId, new Date().toISOString())) {
        return sendJson(res, 403, { ok: false, error: "создание семьи доступно только на Pro" });
      }

      try {
        const result = createFamily(db, { ownerTelegramId: auth.telegramUserId, ownerDisplayName: auth.firstName, nowISO: new Date().toISOString() });
        if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason });
        sendJson(res, 200, { ok: true, status: getFamilyStatus(db, auth.telegramUserId) });
      } catch (err) {
        console.error("[api/family/create] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось создать семью" });
      }
      return;
    }

    // Вступление по ссылке t.me/s_edim_bot?startapp=fam_<invite_code> —
    // случайный код (db.js: genInviteCode), не id семьи (см. комментарий у
    // CREATE TABLE families в db.js — id был бы легко перебираемым). Вступление
    // не требует Pro (Pro нужен только тому, кто СОЗДАЁТ семью — "один
    // подписчик, вся семья пользуется").
    if (req.method === "POST" && req.url === "/api/family/join") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      const parsed = parseFamilyJoinRequest(auth.body);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

      try {
        const result = joinFamily(db, { inviteCode: parsed.value.inviteCode, joiningTelegramId: auth.telegramUserId, displayName: auth.firstName, nowISO: new Date().toISOString() });
        if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason });
        sendJson(res, 200, { ok: true, status: getFamilyStatus(db, auth.telegramUserId) });
      } catch (err) {
        console.error("[api/family/join] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось вступить в семью" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/family/leave") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      try {
        const result = leaveFamily(db, auth.telegramUserId);
        if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason });
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("[api/family/leave] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось покинуть семью" });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/family/status") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      try {
        sendJson(res, 200, { ok: true, status: getFamilyStatus(db, auth.telegramUserId) });
      } catch (err) {
        console.error("[api/family/status] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось получить статус семьи" });
      }
      return;
    }

    // "Отметил купленное один член семьи — увидят все" — общий family_pantry
    // (см. family.js), тот же смысл, что и локальный src/lib/pantry.js на
    // фронтенде, только на всех участников сразу.
    if (req.method === "POST" && req.url === "/api/family/pantry") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      const parsed = parseFamilyPantryRequest(auth.body);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

      try {
        const result = toggleFamilyPantryItem(db, { telegramUserId: auth.telegramUserId, name: parsed.value.name, present: parsed.value.present });
        if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason });
        sendJson(res, 200, { ok: true, pantryNames: result.pantryNames });
      } catch (err) {
        console.error("[api/family/pantry] ошибка:", err);
        sendJson(res, 500, { ok: false, error: "не удалось обновить общий список" });
      }
      return;
    }

    // Общий кэш цен ВкусВилл (см. vkusvillPrices.js) — не привязан к
    // конкретному плану/пользователю, просто "по этим названиям — вот что
    // знаем", поэтому отдельная auth-обвязка (readAuthenticatedBody), а не
    // parsePlanRequest-подобное. Требуем initData наравне со всеми
    // остальными эндпоинтами — не столько ради telegram_user_id (он тут не
    // используется), сколько чтобы не открывать эндпоинт как публичный
    // бесплатный прокси в обход rate-limit ВкусВилл кому угодно в интернете.
    if (req.method === "POST" && req.url === "/api/prices") {
      const auth = await readAuthenticatedBody(req, botToken);
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, error: auth.error });

      const parsed = parsePricesRequest(auth.body);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

      try {
        const resolved = await resolveIngredientPricesWithCache(db, parsed.value.names);
        sendJson(res, 200, { ok: true, prices: [...resolved.entries()].map(([name, v]) => ({ name, ...v })) });
      } catch (err) {
        console.error("[api/prices] ошибка резолвинга:", err);
        sendJson(res, 500, { ok: false, error: "не удалось получить цены" });
      }
      return;
    }

    // Создаёт платёж в ЮKassa и возвращает checkout-ссылку — фронтенд
    // открывает её через Telegram.WebApp.openLink (внешний браузер, ЮKassa
    // не встраивается в WebView мини-приложения). yookassa — конфиг
    // {shopId, secretKey}, может быть не задан (ещё не подключили/тестовое
    // окружение без секрета) — тогда 503, а не падение процесса.
    if (req.method === "POST" && req.url === "/api/pay/create") {
      if (!yookassa) return sendJson(res, 503, { ok: false, error: "оплата ещё не настроена" });

      const auth = await readAuthenticatedBody(req, botToken);
      // readAuthenticatedBody сама по себе ничего не логирует (общая для
      // многих эндпоинтов, некоторые из них дёргаются часто и по мелочи —
      // логировать там каждый отказ было бы шумом). Но именно здесь отказ
      // авторизации — единственная причина, по которой фронтенд покажет
      // "не удалось начать оплату", а бэкенд при этом не оставит НИ ОДНОЙ
      // строки в логах (жалоба в чате: "нажимаю оплатить, логов вообще нет").
      // 401/400 тут стоит видеть явно — иначе отличить "запрос не дошёл до
      // сервера" от "дошёл, но не прошёл авторизацию" нечем вообще.
      if (!auth.ok) {
        console.warn(`[api/pay/create] отказ авторизации (${auth.status}):`, auth.error);
        return sendJson(res, auth.status, { ok: false, error: auth.error });
      }

      // Живая жалоба в чате: "ЮKassa createPayment: Receipt is missing or
      // illegal" — магазин подключён с онлайн-кассой (обычная схема для ИП),
      // она требует фискальный чек на КАЖДЫЙ платёж по 54-ФЗ, а чек требует
      // контакт покупателя. Telegram email не даёт вообще ни при каких
      // условиях — фронтенд теперь сам спрашивает его один раз перед первой
      // оплатой (см. lib/payerContact.js). Простая проверка формата, не
      // полноценная валидация — отсекает пустое/случайно не то поле до
      // похода к ЮKassa, а не полноценно подтверждает существование ящика.
      const email = typeof auth.body.email === "string" ? auth.body.email.trim() : "";
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJson(res, 400, { ok: false, error: "нужен email для чека" });
      }

      // Разовая покупка "ещё один план на этой неделе" (см. EXTRA_PLAN_PRODUCT
      // выше) — второй product у того же эндпоинта, а не отдельный маршрут:
      // авторизация/email/идемпотентность одинаковые, отличается только
      // цена/описание/что происходит по факту оплаты (см. /yookassa/webhook).
      // Не пришёл product вообще — старое поведение (Pro), фронтенд до этой
      // правки его не отправлял.
      const product = auth.body.product === EXTRA_PLAN_PRODUCT ? EXTRA_PLAN_PRODUCT : PRO_PRODUCT;
      const amountRub = product === EXTRA_PLAN_PRODUCT ? EXTRA_PLAN_PRICE_RUB : PRO_PRICE_RUB;
      const description = product === EXTRA_PLAN_PRODUCT ? "Съедим — ещё один план на этой неделе" : `Съедим Pro — ${PRO_PERIOD_DAYS} дней`;

      try {
        const idempotenceKey = randomUUID();
        const payment = await createPayment(yookassa, {
          amountRub,
          description,
          returnUrl: "https://t.me/s_edim_bot",
          telegramUserId: auth.telegramUserId,
          idempotenceKey,
          receiptEmail: email,
        });
        createPendingPayment(db, {
          yookassaPaymentId: payment.id, telegramUserId: auth.telegramUserId,
          amountRub, createdAtISO: new Date().toISOString(), product,
        });
        // Раньше успешный путь не оставлял НИ ОДНОЙ строки в логах — тот же
        // класс путаницы, что и с отказом авторизации выше: диагностика
        // подключения (Аккаунт) подтвердила, что initData/адрес сервера у
        // пользователя в порядке, а логов при этом всё равно не было. Значит
        // либо запрос вообще не доходит на сетевом уровне (тогда и этой
        // строки не будет), либо платёж СОЗДАЁТСЯ успешно, а страница оплаты
        // просто не открывается (Telegram.WebApp.openLink на фронтенде) —
        // раньше эти два случая было решительно нечем отличить.
        console.log(`[api/pay/create] платёж создан: id=${payment.id}, telegram_user_id=${auth.telegramUserId}, product=${product}`);
        sendJson(res, 200, { ok: true, confirmationUrl: payment.confirmationUrl });
      } catch (err) {
        console.error("[api/pay/create] ошибка создания платежа:", err.message);
        sendJson(res, 500, { ok: false, error: "не удалось создать платёж" });
      }
      return;
    }

    // Уведомление от ЮKassa о смене статуса платежа. НЕ проверяем initData —
    // это не Telegram, а сам ЮKassa стучится сюда напрямую. И, что важнее,
    // НЕ доверяем статусу из тела запроса вообще (см. parseYookassaWebhookBody
    // и комментарий у fetchPaymentStatus в yookassa.js) — только id платежа,
    // дальше сами перепроверяем его статус у ЮKassa своими же учётными
    // данными. Отвечаем 200 почти всегда (кроме битого тела/не настроенной
    // оплаты) — иначе ЮKassa будет бесконечно повторять то же уведомление.
    if (req.method === "POST" && req.url === "/yookassa/webhook") {
      if (!yookassa) return sendJson(res, 503, { ok: false, error: "оплата ещё не настроена" });

      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
        return;
      }
      const parsed = parseYookassaWebhookBody(body);
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

      try {
        const status = await fetchPaymentStatus(yookassa, parsed.value.paymentId);
        const existing = getPaymentByYookassaId(db, status.id);
        // Платёж, о котором мы вообще не просили (не создавали через
        // /api/pay/create) — не наш, игнорируем: отвечаем 200, чтобы ЮKassa
        // не повторяла, но ничего не меняем.
        if (!existing) {
          sendJson(res, 200, { ok: true });
          return;
        }
        // Идемпотентность: ЮKassa может прислать одно и то же уведомление
        // несколько раз — если платёж УЖЕ отмечен успешным, не продлеваем
        // Pro/не начисляем кредит повторно на те же деньги. existing.product
        // — что именно куплено (см. createPendingPayment/EXTRA_PLAN_PRODUCT
        // выше), старые платежи до этой колонки читаются как 'pro' (DEFAULT).
        if (status.status === "succeeded" && existing.status !== "succeeded") {
          const nowISO = new Date().toISOString();
          updatePaymentStatus(db, { yookassaPaymentId: status.id, status: "succeeded", confirmedAtISO: nowISO });
          if (existing.product === EXTRA_PLAN_PRODUCT) {
            addExtraPlanCredit(db, existing.telegram_user_id);
          } else {
            extendUserPro(db, existing.telegram_user_id, { fromISO: nowISO, addDays: PRO_PERIOD_DAYS });
          }
        } else if (status.status !== existing.status) {
          updatePaymentStatus(db, { yookassaPaymentId: status.id, status: status.status, confirmedAtISO: null });
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error("[yookassa/webhook] ошибка обработки:", err.message);
        // 500, а не 200 — на реальном сбое (например, сама ЮKassa API
        // недоступна секунду) ХОТИМ, чтобы ЮKassa повторила уведомление позже,
        // а не решила, что мы его успешно обработали.
        sendJson(res, 500, { ok: false, error: "не удалось обработать уведомление" });
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
          // updateWatermark:false — /report это "посмотреть", не "отметить
          // прочитанным" (см. комментарий у sendDigestNow в digest.js).
          await sendDigestNow(db, { botToken, adminTelegramId }, new Date(), { updateWatermark: false });
        } else if (reply?.kind === "backup") {
          await sendBackupNow(db, { botToken, adminTelegramId });
        } else if (reply?.kind === "list_feedback") {
          await sendTelegramMessage(botToken, reply.chatId, buildFeedbackListText(listRecentFeedback(db)));
        } else if (reply?.kind === "feedback") {
          saveFeedback(db, { telegramUserId: reply.telegramUserId, text: reply.text, createdAtISO: new Date().toISOString() });
          await sendTelegramMessage(botToken, reply.chatId, buildFeedbackAckText());
          // Живая жалоба: "не доходят сообщения в поддержку" — раньше
          // обращение только оседало в БД, узнать о нём можно было только
          // руками запросив /feedback. Теперь пушим админу сразу же, отдельно
          // от ack пользователю (см. buildFeedbackAdminNotifyText).
          if (adminTelegramId) {
            await sendTelegramMessage(botToken, adminTelegramId, buildFeedbackAdminNotifyText(reply.telegramUserId, reply.text));
          }
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
