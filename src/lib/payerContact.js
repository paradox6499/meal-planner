// Email для чека ЮKassa — обязателен по 54-ФЗ. Живая жалоба в чате: платёж
// падал с "ЮKassa createPayment: Receipt is missing or illegal" — магазин
// подключён с онлайн-кассой (стандартная схема для ИП), а она требует чек на
// КАЖДЫЙ платёж, а чек требует контакт покупателя (email или телефон).
// Telegram не даёт email пользователя через initData вообще ни при каких
// условиях — единственный источник это сам пользователь. Спрашиваем один
// раз перед первой оплатой (см. ProModal в App.jsx), дальше запоминаем
// локально, чтобы не спрашивать при каждой попытке — тот же принцип, что и
// у profile.js/pantry.js.
const PAYER_EMAIL_KEY = "sedim.payerEmail.v1";

export function loadPayerEmail() {
  try {
    return localStorage.getItem(PAYER_EMAIL_KEY) || "";
  } catch {
    return "";
  }
}

export function savePayerEmail(email) {
  try {
    localStorage.setItem(PAYER_EMAIL_KEY, email);
  } catch {
    // приватный режим браузера / квота исчерпана — молча не сохраняем, это
    // не критичная функция сама по себе, просто спросим email ещё раз в
    // следующий заход
  }
}
