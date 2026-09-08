// Профиль пользователя, сохранённый локально (localStorage) — семья, приёмы
// пищи, рацион, аллергии, кухня, техника, имя, тема. Всё это меняется редко
// (настроил один раз — и на месяцы), поэтому нет смысла проходить полный
// визард из 8 шагов при каждом повторном открытии — только магазин и бюджет
// действительно нужны каждую неделю заново.
//
// Пока нет бэкенда — профиль живёт в localStorage конкретного устройства, не
// синхронизируется между телефоном и десктопом и пропадёт при очистке данных
// сайта / переустановке Telegram. Это осознанный компромисс на первую
// версию: как только появится сервер (см. docs/telegram-bot-architecture.md),
// логичное место для миграции — тот же users-профиль по Telegram user_id.

const PROFILE_KEY = "sedim.profile.v1";
const THEME_KEY = "sedim.theme.v1";

export function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // минимальная валидация формы — повреждённая/чужая запись не должна ронять приложение
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.meals)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // приватный режим браузера / квота исчерпана — молча не сохраняем,
    // это не критичная функция, приложение работает и без неё
  }
}

export function clearProfile() {
  try {
    localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* см. saveProfile */
  }
}

export function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* см. saveProfile */
  }
}
