#!/usr/bin/env node
// Проверка «отвечает ли ВкусВилл с ЭТОГО сервера» — то же, что команда /diag в боте,
// но без бота и без настроек: запустить на новом сервере СРАЗУ после установки Node,
// ещё до переезда (`git clone`, `cd server`, `node scripts/probe-vkusvill.js`).
// Три пробы подряд — одиночный таймаут может быть случайным. Код выхода: 0 — все
// ответили, 1 — хотя бы одна нет.
import { probeVkusvill } from "../src/vkusvillPrices.js";

let failed = 0;
for (let i = 1; i <= 3; i++) {
  const r = await probeVkusvill(10_000);
  console.log(`проба ${i}: ${r.ok ? "ОТВЕЧАЕТ" : "НЕ ОТВЕЧАЕТ"} за ${r.ms} мс — ${r.detail}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}`);
  if (!r.ok) failed++;
  if (i < 3) await new Promise((res) => setTimeout(res, 2000));
}
console.log(failed === 0 ? "Итог: с этого адреса каталог доступен — переезжать сюда можно." : `Итог: не ответило проб — ${failed} из 3. ${failed === 3 ? "Скорее всего, адрес блокируется — этот хостинг не подойдёт." : "Нестабильно — повторите позже."}`);
process.exit(failed === 0 ? 0 : 1);
