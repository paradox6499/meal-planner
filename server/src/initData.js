// Проверка Telegram initData — официальный механизм подтвердить "это
// правда открыл Mini App именно этот telegram_user_id", без пароля и
// логина. Алгоритм из документации Telegram (Validating data received via
// the Mini App):
//
//   secret_key = HMAC_SHA256(bot_token, key="WebAppData")
//   data_check_string = отсортированные по алфавиту "key=value" через \n
//                        (без самого поля hash)
//   ожидаемый hash = HEX(HMAC_SHA256(data_check_string, key=secret_key))
//
// Если это не совпадает — запрос не от настоящего Telegram-клиента (или
// подписан чужим bot_token), доверять telegram_user_id из него нельзя.
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60; // initData от Telegram сам не протухает, но подстраховываемся от replay старой копии

/**
 * @param {string} initData — сырая строка initData из Telegram.WebApp.initData (query-string формата)
 * @param {string} botToken — секрет бота, ТОЛЬКО на сервере, никогда не во фронтенде
 * @param {{ maxAgeSeconds?: number }} [opts]
 * @returns {{ ok: true, user: object, authDate: number } | { ok: false, error: string }}
 */
export function validateInitData(initData, botToken, opts = {}) {
  const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;

  if (!initData || typeof initData !== "string") return { ok: false, error: "initData отсутствует" };
  if (!botToken) return { ok: false, error: "не настроен bot token на сервере" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "нет поля hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // timingSafeEqual вместо === — сравнение хэшей не должно быть уязвимо к
  // timing-атаке (мелочь для бота с рецептами, но это стандартная гигиена
  // для любой проверки подписи, а не сама точка защиты выше).
  const a = Buffer.from(expectedHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "неверная подпись — не настоящий Telegram initData" };
  }

  const authDate = Number(params.get("auth_date"));
  if (maxAgeSeconds > 0 && (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds)) {
    return { ok: false, error: "initData устарела" };
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return { ok: false, error: "поле user не парсится" };
  }
  if (!user || typeof user.id !== "number") return { ok: false, error: "нет user.id в initData" };

  return { ok: true, user, authDate };
}
