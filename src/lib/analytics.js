// Свой минимальный event-трекинг поверх того же бэкенда, что и напоминания
// (server/) — не сторонний SaaS: initData уже несёт telegram_id, гонять его
// во внешний сервис (Amplitude/PostHog и т.п.) — лишний вендор и лишний
// вопрос про 152-ФЗ при таком масштабе. Тот же принцип best-effort, что и в
// backend.js: без VITE_BACKEND_URL или вне Telegram — тихо ничего не делает,
// ни один вызов trackEvent не должен уметь сломать основной сценарий.
export function trackEvent(eventName, props = null) {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;
  if (!backendUrl) return;

  const tg = window.Telegram?.WebApp;
  if (!tg?.initData) return;

  // fire-and-forget: аналитика не должна ни блокировать интерфейс, ни падать
  // с необработанным rejection, если сеть моргнула.
  fetch(`${backendUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: tg.initData, eventName, props }),
  })
    .then((res) => {
      // Тот же пробел, что был в backend.js (см. его комментарии): fetch()
      // не бросает на HTTP 4xx/5xx, только на сетевой сбой — без этой
      // проверки отклонённое сервером событие (например initData "устарела")
      // выглядело бы как успех, а ежедневный отчёт админу ("/report") честно
      // писал бы "Событий не было", хотя события на самом деле отправлялись,
      // просто сервер их не принимал.
      if (!res.ok) console.warn(`Сервер отклонил событие "${eventName}":`, res.status);
    })
    .catch((err) => {
      console.warn(`Не удалось отправить событие "${eventName}":`, err.message);
    });
}
