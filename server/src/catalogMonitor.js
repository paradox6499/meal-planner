// Мониторинг "отвечает ли ВкусВилл с нашего сервера". Нужен, потому что каталог
// — основа продукта (рецепты, цены, корзина), а отказ тихий: пользователь видит
// только "каталог не ответил", админ — ничего. Раз в несколько минут делаем
// одну пробную выборку; после двух неудач подряд пишем админу в Telegram, при
// восстановлении — тоже (не на каждую неудачу, чтобы не засыпать).
import { probeVkusvill } from "./vkusvillPrices.js";
import { sendTelegramMessage } from "./telegram.js";

const state = { ok: null, failures: 0, lastProbe: null };

export function getCatalogState() {
  return { ...state };
}
export function resetCatalogState() {
  state.ok = null;
  state.failures = 0;
  state.lastProbe = null;
}

export async function runCatalogMonitorTick({ botToken, adminTelegramId = null }, now = new Date()) {
  const probe = await probeVkusvill();
  state.lastProbe = { ...probe, at: now.toISOString() };
  const wasOk = state.ok;

  if (probe.ok) {
    state.failures = 0;
    state.ok = true;
    if (wasOk === false) await notify(botToken, adminTelegramId, `✅ ВкусВилл с сервера снова отвечает (${probe.ms} мс).`);
    return state;
  }

  state.failures += 1;
  if (state.failures >= 2 && wasOk !== false) {
    state.ok = false;
    await notify(
      botToken,
      adminTelegramId,
      `❌ ВкусВилл с сервера не отвечает: ${probe.detail}${probe.httpStatus ? ` [HTTP ${probe.httpStatus}]` : ""}. Пока это так, планы собираются из базового набора рецептов без цен. Подробности: /diag`
    );
  }
  return state;
}

async function notify(botToken, adminTelegramId, text) {
  if (!adminTelegramId) return;
  try {
    await sendTelegramMessage(botToken, adminTelegramId, text);
  } catch (err) {
    console.error("[catalogMonitor] не удалось отправить уведомление админу:", err.message);
  }
}
