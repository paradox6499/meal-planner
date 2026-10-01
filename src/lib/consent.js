// Согласие с пользовательским соглашением и политикой конфиденциальности
// перед оплатой (152-ФЗ и закон о защите прав потребителей: условия должны
// быть доступны ДО платежа, а согласие — осознанным). Запоминается локально,
// чтобы не спрашивать при каждой оплате; не уходит на сервер.
const CONSENT_KEY = "sedim.consent.v1";

export function loadConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveConsent() {
  try {
    localStorage.setItem(CONSENT_KEY, "1");
  } catch {
    /* приватный режим/квота — спросим снова при следующей оплате, не критично */
  }
}

/** Абсолютный адрес страницы документа рядом с приложением (privacy.html и
 * terms.html лежат в public/ и раздаются с того же адреса, что и само
 * приложение — GitHub Pages сейчас, а при переезде на другой хостинг
 * продолжат работать без правок кода). Хэш с initData Telegram отбрасывается. */
export function legalUrl(page) {
  try {
    return new URL(page, window.location.href).href;
  } catch {
    return page;
  }
}

/** Открывает документ: внутри Telegram — через openLink (внешний браузер,
 * Mini App остаётся на месте), иначе — новая вкладка. */
export function openLegalPage(page) {
  const url = legalUrl(page);
  const tg = typeof window !== "undefined" ? window.Telegram?.WebApp : null;
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
