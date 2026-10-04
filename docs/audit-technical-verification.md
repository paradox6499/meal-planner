# Технический аудит «Съедим» — проверка исправлений

- Дата: 04.10.2026
- Состояние репозитория: `main` @ `5ea0eec`
- Что проверялось: `docs/audit-followup-technical.md` (отчёт автора о сделанном) против кода
- Исходный отчёт: `docs/audit-technical-report.md`, нумерация та же
- Тесты: сервер 383/383, фронтенд 270/270 — всё зелёное

Как проверял: перечитал изменённый код. Отдельно прогнал скрипт против настоящего серверного кода (in-memory БД, подписанный initData; см. приложение A) и сделал живой замер ВкусВилл: сколько уникальных ингредиентов уходит в запрос цен при одной сборке.

Пометки: **[ПОДТВЕРЖДЕНО]** — воспроизведено скриптом или замером. **[ПО КОДУ]** — вывод из чтения кода.

---

## 1. Итог

Почти всё, что отмечено как сделанное, действительно сделано. Двойной выдачи оплаченного или выдачи без проверки у ЮKassa я не нашёл. Но появилась одна **новая подтверждённая дыра**: после удаления аккаунта можно бесконечно получать Pro по реферальной ссылке и сбрасывать бесплатный лимит. Её стоит закрыть первой.

---

## 2. Ответы на 5 вопросов из `audit-followup-technical.md`

**1. `applyPaymentStatus`: можно ли выдать оплаченное дважды или без проверки у ЮKassa.** Нет.
- Статус всегда берётся напрямую у ЮKassa: в вебхуке (`server/src/app.js:1009`) и в сверке (`server/src/payments.js:147`).
- Выдача стоит за условием `existing.status !== "succeeded"`. Статусы `refunded` и `review` дальше не меняются (`payments.js:49`). Успешный платёж нельзя откатить в другой статус (`payments.js:86`).
- Между проверкой и записью нет `await`, поэтому одновременные вебхук и сверка безопасны: второй вызов ничего не делает.

**2. `/api/plan/generate`: нет `await` между проверкой и записью.** Подтверждаю (`app.js:478-508`), весь обработчик после авторизации синхронный.

**3. Полнота `deleteUserData`** (`server/src/db.js:921-948`). Удаляются все таблицы с id пользователя: `users`, `meal_slots`, `events`, `plan_history`, `feedback`, `referrals` (в обеих ролях), `family_members`, у владельца — `families` и `family_pantry`. Платежи остаются. Удаление выполняется в одной транзакции. **Но здесь же новая дыра, см. раздел 3.**

**4. `parseYookassaWebhookBody`** (`app.js:333-346`). Граничные случаи обработаны верно:
- у возврата без `payment_id` ответ 400;
- `payout.*`, `deal.*` и другие неизвестные семейства событий игнорируются с ответом 200, без запроса к ЮKassa;
- тело без поля `event` разбирается как платёж по `object.id`.

**5. Не режут ли потолки обычное использование.**
- События (`EVENTS_PER_USER_PER_DAY = 300`): не режут, запас большой.
- Цены (`PRICES_LIVE_FETCHES_PER_REQUEST = 60`): **режут** при первой сборке новых комбинаций, см. раздел 4, пункт 4.

---

## 3. НОВОЕ: удаление аккаунта обнуляет рефералы и лимит [ПОДТВЕРЖДЕНО] — ВЫСОКИЙ

Схема: заявка на реферала → сборка плана → «Удалить мои данные» → снова заявка, и так по кругу. Результат трёх кругов (скрипт в приложении A):

```
round 1: claim true   A pro_until=2026-10-11   B usedThisWeek 1 → после удаления 0
round 2: claim true   A pro_until=2026-10-18
round 3: claim true   A pro_until=2026-10-25   (+7 дней пригласившему за круг)
```

Почему так:
- `deleteUserData` удаляет строку `referrals`, где пользователь приглашённый (`db.js:940`). После удаления строки `users` функция `claimReferral` (`server/src/referrals.js:34-50`) снова видит «нового» пользователя.
- Потолок пригласившего (`MAX_REWARDED_REFERRALS = 12`) считается через `COUNT` по тем же строкам (`countRewardedReferrals`). Каждое удаление его снижает, так что потолок никогда не срабатывает.
- Удаляются и события `plan_generated`, поэтому бесплатный недельный лимит тоже сбрасывается.

Чем это грозит: пара аккаунтов даёт пригласившему бесконечный Pro, приглашённый получает по 7 дней Pro на каждом круге, бесплатный лимит обходится без ограничений. Репозиторий публичный, так что эту схему может найти любой.

Как исправить (2–3 часа):
1. Таблица `deleted_accounts(id_hash TEXT PRIMARY KEY, deleted_at TEXT, referral_used INTEGER, last_free_plan_at TEXT)`, где `id_hash = HMAC-SHA256(серверный секрет, telegram_user_id)`. Заполняется в той же транзакции, что и `deleteUserData`.
2. `claimReferral` отказывает, если хэш есть и `referral_used = 1`.
3. `/api/plan/generate` и `/api/plan-status` учитывают `last_free_plan_at` из `deleted_accounts` как бесплатную сборку внутри окна.
4. Потолок пригласившего хранить неудаляемым счётчиком на его стороне (`users.referral_rewards_total`), а не считать строки `referrals`.
5. Добавить в `public/privacy.html`, что после удаления хранится обезличенный хэш для защиты от злоупотреблений, с основанием (законный интерес) и сроком (например, 12 месяцев). В `maintenance.js` — очистка по сроку.
6. Тест: удаление → повторная заявка → `claimed: false`, у пригласившего `pro_until` не растёт, `canGenerate` учитывает сборку до удаления.

---

## 4. Остаточные замечания по исправленным пунктам

### 4.1 (#4) Нет таймаутов у внешних запросов, `plan-status` ждёт ЮKassa [ПО КОДУ] — СРЕДНИЙ
- У `fetch` к ЮKassa (`server/src/yookassa.js:40`, `:83`) и к Telegram (`server/src/telegram.js:20`, `:84`) нет таймаутов.
- `/api/plan-status` теперь ждёт до 3 последовательных `fetchPaymentStatus` **и** отправку уведомлений и только потом отвечает (`app.js:582-589`).
- Если ЮKassa или Telegram тормозят, клиент через 6 секунд (`fetchWithTimeout`) получает пустой ответ. Это ровно момент возвращения после оплаты, когда статус нужнее всего.

Исправление (около часа):
- `signal: AbortSignal.timeout(5000)` во всех четырёх `fetch`.
- В `plan-status` сначала ответить, а `notifyPaymentResult` вызывать после ответа, как уже сделано в вебхуке (`app.js:1014-1018`).

### 4.2 (#4) Частичный возврат по платежу, который у нас ещё `pending` [ПО КОДУ] — НИЗКИЙ
Если вебхук об успехе потерялся, а потом сделали частичный возврат, ветка возврата срабатывает раньше выдачи (`payments.js:65-67`):
- оплаченное не выдаётся никогда;
- статус остаётся `pending`, и сверка с `minIntervalMs: 0` (`payments.js:158`) алертит админа каждые 10 минут в течение 48 часов — около 288 сообщений.

Исправление: при частичном возврате по `pending` ставить статус `review` (выпадает из сверки) и алертить один раз.

### 4.3 (#4) Ключ идемпотентности на минуту [ПО КОДУ] — НИЗКИЙ
`paymentIdempotenceKey` (`payments.js:32-34`) = sha256(пользователь | товар | минута).
- Пользователь отменил оплату на странице ЮKassa и повторил в ту же минуту — ЮKassa вернёт тот же отменённый платёж, ссылка будет мёртвой.
- Email сменили в пределах минуты — ЮKassa, вероятно, отклонит повтор ключа с другими параметрами. Нужно сверить с документацией ЮKassa.

Исправление: добавить email в хэш. Если `createPayment` вернул платёж не в статусе `pending` (`app.js:940-955`), повторить с новым ключом (например, с суффиксом `|retry`).

### 4.4 (#5) Потолок цен режет первую сборку новых комбинаций [ПОДТВЕРЖДЕНО] — СРЕДНИЙ
Живой замер `fetchVkusvillPools` без фильтров:

| Категории | Рецептов в пуле | Уникальных названий ингредиентов |
|---|---|---|
| только main | 20 | 82 |
| breakfast + main + snack | 60 | 157 |

- `attachRealCosts` отправляет в `/api/prices` все названия пула (`src/lib/vkusvillRecipes.js:332-346`), а не только плана.
- С потолком 60 живых запросов на вызов (`app.js:56`) при первой сборке новой комбинации около 97 названий вернутся как `matched: false` (`server/src/vkusvillPrices.js`, блок `skipped`).
- Это выглядит точно так же, как настоящее «не найдено». Фронтенд откатывается на прямые запросы к ВкусВилл, только если пуст весь ответ (`vkusvillRecipes.js:346`), поэтому пропущенные названия остаются без цены.
- Устаревший кэш отдаётся нормально (`stale ? stale : ...`), так что страдают только названия, которых в кэше ещё нет.

Исправление (около часа), на выбор:
- поднять `PRICES_LIVE_FETCHES_PER_REQUEST` до 160–200 (часовой бюджет 240 можно оставить или поднять до 400);
- либо возвращать для пропущенных `skipped: true`, а на фронтенде догружать их через `resolvePrices` напрямую.

### 4.5 (#1/#2) Сборки на Pro пишутся как `plan_generated` [ПО КОДУ] — НИЗКИЙ
`app.js:485`. Когда Pro заканчивается, сборки периода Pro до 7 дней блокируют бесплатный план (`countPlanGenerationsSince` их считает). Исправление: писать `plan_generated_pro` и добавить подпись в `EVENT_LABELS`.

### 4.6 Реферальная награда всё ещё в синхронизации `/api/plan` [ПО КОДУ] — НИЗКИЙ
`app.js:456-460`. По смыслу «приглашённый активировался» — это сборка (`/api/plan/generate`). Сейчас награду вызывает любой `/api/plan`, который клиент может прислать и без сборки. Исправление: перенести `maybeRewardReferral` в `generate`, в ветки `free` и `credit`.

### 4.7 (#9) Тики планировщика могут накладываться — по-прежнему открыто [ПО КОДУ] — НИЗКИЙ
`server/src/index.js`: таймеров теперь 7 (`:83`, `:95`, `:110`, `:132`, `:152`, `:169`, `:183`), внешние запросы без таймаутов (см. 4.1). Если тик длится дольше интервала, следующий стартует параллельно, и напоминания уходят дважды (`markReminderSent` вызывается после `await`). Исправление — флаг на каждый тик:
```js
let running = false;
async function tick() { if (running) return; running = true; try { /* ... */ } finally { running = false; } }
```

---

## 5. Сверка статусов из `audit-followup-technical.md`

| Пункт | Статус автора | Вердикт проверки |
|---|---|---|
| #1 Лимит при открытии | ГОТОВО | Согласен. Остаток — 4.6 |
| #2 Формула кредитов | ГОТОВО | Согласен. Остаток — 4.5 |
| #3 Markdown | ГОТОВО | Согласен: `parse_mode` по умолчанию не отправляется (`telegram.js:26`), подписи в `EVENT_LABELS` есть для всех событий фронтенда (проверено скриптом) |
| #4 Оплата | ГОТОВО | Согласен по сути. Остаток — 4.1, 4.2, 4.3 |
| #5 Диск / ВкусВилл | ГОТОВО | Диск — согласен. Потолок цен слишком жёсткий — 4.4 |
| #6 152-ФЗ | ЧАСТИЧНО | Согласен. Новое — раздел 3 (удаление открывает злоупотребление) |
| #7 Миграции | НЕ СДЕЛАНО | Согласен. Приоритет вырос: раздел 3 добавит таблицу, опять без версий схемы |
| #8 Слабая связь | ГОТОВО | Не перепроверял вживую, тесты есть |
| #9 Реферер при claim | ОТКЛОНЕНО | Аргумент верный. Но проверка реферера в момент награды не закроет раздел 3 — нужно исправление оттуда |
| #9 Наложение тиков | НЕ СДЕЛАНО | Согласен, см. 4.7 |

---

## 6. Что делать дальше, по порядку

1. **Раздел 3** — дыра «удаление → повторный реферал и сброс лимита». 2–3 часа.
2. **4.1** — таймауты внешних запросов и ответ `plan-status` до уведомлений. ~1 час.
3. **4.4** — потолок цен на вызов или флаг `skipped`. ~1 час.
4. **4.2 + 4.3** — частичный возврат по `pending` и крайние случаи ключа идемпотентности. 1–2 часа.
5. **4.5 + 4.6** — `plan_generated_pro` и перенос реферальной награды в `generate`. ~30 минут.
6. **4.7** — защита тиков от наложения. ~30 минут.

После этого — стратегический пункт 1 из исходного отчёта: отдельная таблица прав доступа (`plan_generations` с источником, учёт кредитов, `deleted_accounts`) и версионированные миграции через `PRAGMA user_version` с тестом апгрейда старой схемы.

---

## Приложение A. Скрипт воспроизведения раздела 3

Запуск из корня репозитория: `node probe-delete.mjs` (Node ≥ 22.5). Внешних зависимостей нет. Запросы к Telegram подменяются заглушкой, сервер — настоящий `createApp` с in-memory БД.

```js
import { createHmac } from "node:crypto";
const S = new URL("./server/src/", import.meta.url).href;
const { openDb } = await import(S + "db.js");
const { createApp } = await import(S + "app.js");
// заглушка Telegram Bot API, остальные запросы — как есть
globalThis.fetch = ((orig) => (url, opts) => String(url).startsWith("https://api.telegram.org")
  ? Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }))) : orig(url, opts))(globalThis.fetch);
const TOKEN = "1:T";
function initData(id) {
  const f = { user: JSON.stringify({ id, first_name: "T" }), auth_date: String(Math.floor(Date.now() / 1000)) };
  const dcs = Object.entries(f).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const sk = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  return new URLSearchParams({ ...f, hash: createHmac("sha256", sk).update(dcs).digest("hex") }).toString();
}
const db = openDb(":memory:");
const srv = createApp(db, { botToken: TOKEN });
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;
const post = (p, id, b = {}) => fetch(base + p, { method: "POST", body: JSON.stringify({ initData: initData(id), ...b }) }).then(async (r) => [r.status, await r.json()]);
const slot = { scheduledDate: "2026-10-04", mealType: "dinner", mealLabel: "Ужин", mealTime: "19:00", recipeName: "Паста" };
const proUntil = (id) => db.prepare("SELECT pro_until FROM users WHERE telegram_user_id = ?").get(id)?.pro_until ?? null;
const A = 100, B = 200; // A — пригласивший, B — приглашённый
for (let round = 1; round <= 3; round++) {
  console.log(`round ${round}: claim`, (await post("/api/referral/claim", B, { referrerTelegramId: A }))[1].claimed);
  await post("/api/plan/generate", B);
  await post("/api/plan", B, { timezoneOffsetMinutes: 180, mealSlots: [slot] }); // здесь начисляется награда
  console.log(`  A pro_until=${proUntil(A)}  B pro_until=${proUntil(B)}`);
  console.log(`  B usedThisWeek=${(await post("/api/plan-status", B))[1].usedThisWeek}`);
  await post("/api/account/delete", B, { confirm: true });
  console.log(`  после удаления: B usedThisWeek=${(await post("/api/plan-status", B))[1].usedThisWeek}`);
}
srv.close();
```

Фактический вывод на `5ea0eec`: на каждом круге `claim true`, `pro_until` пригласившего растёт на 7 дней (10-11 → 10-18 → 10-25), `usedThisWeek` приглашённого после удаления — 0.

## Приложение B. Замер размера запроса цен

Временный vitest-тест в `src/` (нужен `import.meta.env`, поэтому vitest, а не голый node), после запуска удалить. Делает несколько живых запросов к ВкусВилл.

```js
import { it } from "vitest";
import { fetchVkusvillPools } from "./lib/vkusvillRecipes.js";
it("probe", async () => {
  globalThis.window = { Telegram: undefined };
  for (const cats of [["main"], ["breakfast", "main", "snack"]]) {
    const { pools } = await fetchVkusvillPools({ diet: "any", cuisines: [], devices: [], allergies: [], categories: cats, maxCookTime: null });
    const names = new Set(); let recipes = 0;
    Object.values(pools).forEach((l) => l.forEach((r) => { recipes++; r.ingr.forEach(([n]) => names.add(n)); }));
    process.stdout.write(`PROBE ${cats.join("+")} recipes=${recipes} names=${names.size}\n`);
  }
}, 120000);
```

Результат 04.10.2026: `main recipes=20 names=82`, `breakfast+main+snack recipes=60 names=157`.
