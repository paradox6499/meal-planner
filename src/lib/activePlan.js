// Текущий собранный план — сохраняется локально (localStorage), чтобы при
// повторном открытии приложения (вышли из Telegram и зашли снова, перезапуск
// WebView и т.п.) пользователь сразу видел СВОЙ план на неделю, а не визард
// "собрать новый план" заново. Раньше planState/pools/priceByName жили только
// в React-состоянии — оно исчезает при каждом перемонтировании компонента, и
// единственным способом попасть в уже собранный план было пройти сборку
// заново (жалоба в чате: "как посмотреть старый план, который я уже собрал").
//
// Профиль (family/meals/diet/...) уже переживает перезапуск через profile.js —
// этот модуль закрывает последний недостающий кусок: сам план (store, budget,
// planState, pools, priceByName).
//
// Живой вывод из ревью Pro-плюшек (чат): "Несколько планов одновременно"
// рекламировалось как Pro-бонус, а по факту всегда хранился РОВНО один план —
// "Заново" стирал предыдущий безвозвратно. Формат хранения теперь — массив
// СЛОТОВ (id + сам план) плюс указатель на активный, а не один голый объект.
// MAX_PRO_SLOTS ограничивает, сколько слотов вообще может быть одновременно —
// сама проверка "хватает ли Pro на добавление ещё одного" остаётся на стороне
// App.jsx (этот модуль ничего не знает про тарифы, только хранит то, что ему
// дают, как и раньше).
const SLOTS_KEY = "sedim.activePlanSlots.v1";
// Старый формат (один план без обёртки в слоты) — читаем один раз для
// миграции существующих пользователей, дальше не пишем сюда ничего нового.
const LEGACY_SINGLE_KEY = "sedim.activePlan.v1";

export const MAX_PRO_SLOTS = 3;

// export — App.jsx генерирует id ДО первого сохранения (сразу при "Ещё один
// план"/новой сборке), чтобы уже во время сборки/визарда знать, в какой слот
// в итоге сохранить результат, а не изобретать id заново в двух местах.
export function genSlotId() {
  // crypto.randomUUID доступен во всех современных WebView (Telegram Mini
  // Apps требуют актуальный движок) — запасной вариант на случай локального
  // превью в необычном окружении, не для продакшена.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function deserializeSlot(raw) {
  if (!raw || typeof raw !== "object" || !raw.id || !raw.planState || !raw.pools) return null;
  return {
    id: raw.id,
    store: raw.store ?? null,
    budget: raw.budget ?? 4000,
    planState: raw.planState,
    pools: raw.pools,
    // Map не переживает JSON.stringify как есть (см. serializeSlot ниже) —
    // храним как массив пар и восстанавливаем здесь же, чтобы вызывающему
    // коду (App.jsx) не приходилось знать об этой детали сериализации.
    priceByName: Array.isArray(raw.priceByNameEntries) ? new Map(raw.priceByNameEntries) : null,
    createdAt: raw.createdAt ?? null,
  };
}

function serializeSlot(slot) {
  return {
    id: slot.id,
    store: slot.store,
    budget: slot.budget,
    planState: slot.planState,
    pools: slot.pools,
    priceByNameEntries: slot.priceByName ? [...slot.priceByName.entries()] : null,
    createdAt: slot.createdAt ?? new Date().toISOString(),
  };
}

function readStore() {
  try {
    const raw = localStorage.getItem(SLOTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.slots)) return null;
    const slots = parsed.slots.map(deserializeSlot).filter(Boolean);
    return { slots, activeSlotId: parsed.activeSlotId ?? (slots[0]?.id ?? null) };
  } catch {
    return null;
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(
      SLOTS_KEY,
      JSON.stringify({ activeSlotId: store.activeSlotId, slots: store.slots.map(serializeSlot) })
    );
  } catch {
    // приватный режим браузера / квота исчерпана (пулы ВкусВилл с полным
    // составом и шагами рецептов могут быть не самыми маленькими) — молча не
    // сохраняем, это не критичная функция: план просто не восстановится при
    // следующем открытии, тот же принцип, что и у profile.js.
  }
}

// Одноразовая миграция старого единственного плана в новый формат из одного
// слота — чтобы у уже пользующихся приложением людей план не "пропал" после
// обновления. Выполняется максимум один раз: как только новый ключ появится
// в localStorage (даже пустой), сюда больше не заходим.
function migrateLegacyIfNeeded() {
  try {
    if (localStorage.getItem(SLOTS_KEY) != null) return; // уже мигрировали (или начали с нуля в новом формате)
    const legacyRaw = localStorage.getItem(LEGACY_SINGLE_KEY);
    if (!legacyRaw) {
      writeStore({ slots: [], activeSlotId: null }); // помечаем "мигрировано", дальше просто нет старого плана
      return;
    }
    const legacy = JSON.parse(legacyRaw);
    if (!legacy || typeof legacy !== "object" || !legacy.planState || !legacy.pools) {
      writeStore({ slots: [], activeSlotId: null });
      return;
    }
    const slot = {
      id: genSlotId(),
      store: legacy.store ?? null,
      budget: legacy.budget ?? 4000,
      planState: legacy.planState,
      pools: legacy.pools,
      priceByName: Array.isArray(legacy.priceByNameEntries) ? new Map(legacy.priceByNameEntries) : null,
      createdAt: null,
    };
    writeStore({ slots: [slot], activeSlotId: slot.id });
  } catch {
    // повреждённая старая запись — не мигрируем, просто начинаем с пустого набора слотов
    writeStore({ slots: [], activeSlotId: null });
  }
}

/** {slots: [{id, store, budget, planState, pools, priceByName, createdAt}],
 * activeSlotId}. Пустой slots — обычное дело для нового пользователя, не
 * ошибка. */
export function loadActivePlanSlots() {
  migrateLegacyIfNeeded();
  return readStore() ?? { slots: [], activeSlotId: null };
}

/** Создаёт (если id ещё не было) или обновляет (если был) слот с этим id —
 * тот же вызов на "собрать план" И на "заменить блюдо в уже собранном"
 * (см. App.jsx: эффект на каждое изменение planState/pools/priceByName). НЕ
 * трогает activeSlotId сам — вызывающий код решает, делать ли этот слот
 * активным (см. setActiveSlotId), обновление в фоне не должно переключать
 * пользователя на другой план. */
export function saveActivePlanSlot({ id, store, budget, planState, pools, priceByName, createdAt }) {
  const current = readStore() ?? { slots: [], activeSlotId: null };
  const idx = current.slots.findIndex((s) => s.id === id);
  const slot = { id, store, budget, planState, pools, priceByName, createdAt: createdAt ?? current.slots[idx]?.createdAt ?? new Date().toISOString() };
  const slots = idx >= 0 ? current.slots.map((s, i) => (i === idx ? slot : s)) : [...current.slots, slot];
  writeStore({ slots, activeSlotId: current.activeSlotId });
}

export function setActiveSlotId(id) {
  const current = readStore() ?? { slots: [], activeSlotId: null };
  writeStore({ slots: current.slots, activeSlotId: id });
}

/** Удаляет один слот. Если удалили активный — новый активный выбирается
 * автоматически (первый оставшийся, иначе null — тогда приложение честно
 * покажет визард, как у пользователя без единого плана). */
export function removeActivePlanSlot(id) {
  const current = readStore() ?? { slots: [], activeSlotId: null };
  const slots = current.slots.filter((s) => s.id !== id);
  const activeSlotId = current.activeSlotId === id ? (slots[0]?.id ?? null) : current.activeSlotId;
  writeStore({ slots, activeSlotId });
}

/** Полный сброс — используется при сбросе всего профиля (см. App.jsx:
 * handleClearProfile), не при обычном "Заново" (тот трогает только один
 * слот, см. removeActivePlanSlot). */
export function clearAllActivePlans() {
  try {
    localStorage.removeItem(SLOTS_KEY);
    localStorage.removeItem(LEGACY_SINGLE_KEY);
  } catch {
    /* см. writeStore */
  }
}
