// «Откуда вы о нас узнали» — необязательный вопрос новичку после первого плана (раньше мы не знали, какой канал
// работает: канал в Telegram, друзья, реклама). Ответ уходит отдельным событием на каждый вариант (так он сам
// попадает в ежедневный отчёт админу счётчиком), а факт «спросили» хранится локально — повторно не спрашиваем.
export const ACQUISITION_OPTIONS = [
  { id: "friend", label: "От друзей или семьи", event: "acq_friend" },
  { id: "channel", label: "Из Telegram-канала", event: "acq_channel" },
  { id: "ads", label: "Из рекламы", event: "acq_ads" },
  { id: "search", label: "Нашёл в поиске", event: "acq_search" },
  { id: "social", label: "Соцсети и видео", event: "acq_social" },
  { id: "other", label: "Другое", event: "acq_other" },
];

const KEY = "sedim.acquisition.v1";

export function loadAcquisitionAnswered() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAcquisitionAnswered() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* приватный режим — спросим ещё раз при следующей первой сессии, не критично */
  }
}

/** Что за ссылка открыла приложение — только тип, без самого кода (в нём может быть id человека или семьи). */
export function startParamKind(startParam) {
  if (!startParam) return "none";
  if (/^ref_/.test(startParam)) return "ref";
  if (/^fam_/.test(startParam)) return "fam";
  return "other";
}
