// Простой rate limiter в памяти процесса — ни одной внешней зависимости
// (сервер сознательно держит ноль npm-пакетов в рантайме, см. package.json,
// добавлять express-rate-limit ради одной функции того не стоит).
// Фиксированное окно (не скользящее, не token bucket) — заметно проще
// реализовать и протестировать правильно, а для защиты от заливки запросов
// точность "плюс-минус одно окно" не имеет значения, в отличие от
// биллинга/квот. Один процесс на Render (нет горизонтального
// масштабирования у этого сервиса) — общий Map в памяти достаточен, шардить
// между инстансами не нужно.
//
// Живой вывод из ревью безопасности (чат): "стоит сделать rate limiting" —
// конкретная угроза, которая это подтолкнула: /api/prices принимает до 300
// названий за раз, каждое непопадание в кэш — живой запрос к ВкусВилл; один
// пользователь с ОДНОЙ действительной сессией мог заваливать сервер
// выдуманными названиями и посадить общий (на всех пользователей) rate-limit
// ВкусВилл — ту же проблему уже один раз ловили этим летом от обычного
// использования, теперь это ещё и осознанный вектор злоупотребления.

const buckets = new Map(); // key -> { count, windowStart }

// Верхняя граница на количество РАЗНЫХ ключей одновременно в памяти — тот же
// принцип, что у CACHE_MAX_ENTRIES в vkusvillMcp.js: вытесняем самую старую
// запись, а не даём Map расти неограниченно, если через сервис проходят
// тысячи разных telegram_user_id за время жизни процесса.
const MAX_TRACKED_KEYS = 5000;

/** true — лимит превышен, запрос стоит отклонить (429). false — можно
 * пропустить, сам вызов уже учтён в счётчике. now — параметр, а не
 * Date.now() внутри функции, чтобы тесты были детерминированными — тот же
 * принцип, что и у nowISO везде в этом файле/проекте. */
export function isRateLimited(key, { maxRequests, windowMs, now = Date.now() }) {
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    if (!bucket && buckets.size >= MAX_TRACKED_KEYS) {
      buckets.delete(buckets.keys().next().value); // вытесняем самую старую запись, не самая точная LRU, но и не нужна точнее
    }
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > maxRequests;
}

// Бюджет в "штуках" (а не запросах): сколько единиц дорогой работы может
// выполнить один ключ за окно. Нужен там, где один запрос может стоить и 1, и
// 300 единиц (например, живые обращения к ВкусВилл за ценами, см. /api/prices) —
// счётчик запросов их не различает.
const budgets = new Map(); // key -> { used, windowStart }

/** Выдаёт из бюджета до wanted единиц и возвращает, сколько ВЫДАНО (0..wanted).
 * Фиксированное окно, как и isRateLimited. */
export function takeBudget(key, wanted, { capacity, windowMs, now = Date.now() }) {
  let bucket = budgets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    if (!bucket && budgets.size >= MAX_TRACKED_KEYS) {
      budgets.delete(budgets.keys().next().value);
    }
    bucket = { used: 0, windowStart: now };
    budgets.set(key, bucket);
  }
  const granted = Math.max(0, Math.min(wanted, capacity - bucket.used));
  bucket.used += granted;
  return granted;
}

/** Только для тестов — сбрасывает всё состояние между тестами, тот же
 * паттерн, что и clearMcpCache в src/lib/vkusvillMcp.js на фронтенде. */
export function clearRateLimitState() {
  buckets.clear();
  budgets.clear();
}
