// Окна оплаты: Pro и «ещё один план», цены и список преимуществ Pro.

import { useState } from "react";
import { X, Sparkles, Check, Loader2 } from "lucide-react";
import { createProPayment, createExtraPlanPayment } from "../lib/backend.js";
import { loadPayerEmail, savePayerEmail } from "../lib/payerContact.js";
import { loadConsent, saveConsent } from "../lib/consent.js";
import { trackEvent } from "../lib/analytics.js";
import { hapticImpact, hapticNotify } from "../lib/haptics.js";
import { styles, ACCENT } from "../styles.js";
import { ConsentCheckbox } from "./common.jsx";

// Просьба в чате: "показывался план при входе... и лаконично внизу кнопка
// перейти на про режим" — рендерится вместо визарда, когда локального плана
// нет, но по бэкенду ясно, что план на эту неделю уже собирали (см. эффект
// lastPlanGate в App() выше). Данных для полноценного ResultView с реальным
// списком покупок в истории НЕТ (savePlanToHistory сознательно хранит только
// day/блюда + total — не сам сгруппированный список покупок, см. комментарий
// там же) — здесь честный, более скромный экран: дни и блюда (кликабельные,
// как в PlanHistorySection) и итоговая сумма, без попытки притвориться
// полным ResultView.
export const PRO_PRICE_RUB = 299;

// Живой вывод из ревью Pro-плюшек (чат): "разовая дешёвая покупка ещё одного
// плана на этой неделе как ступенька перед полной подпиской". Дублирует
// EXTRA_PLAN_PRICE_RUB из server/src/app.js — тот же принцип, что и у
// REFERRAL_REWARD_DAYS_LABEL/MAX_FAMILY_MEMBERS_LABEL выше: цифра для текста
// на фронтенде неизбежно живёт отдельной строкой от источника истины на
// сервере, держите их в синхроне вручную, если поменяются.
export const EXTRA_PLAN_PRICE_RUB = 59;

// Реальная оплата подключена — ЮKassa (см. server/src/yookassa.js,
// POST /api/pay/create). Одноразовый платёж на 30 дней, не автопродление
// (см. public/terms.html раздел 3) — ручной переключатель
// server/scripts/set-pro.js по-прежнему отдельно работает для тестирования,
// оплата его не заменяет, а дополняет (см. db.js: getUserPro).
// Раньше был один абзац текста — сухое перечисление без объяснения "зачем
// мне это". Пользователь в чате прямо попросил: разворачивающиеся пункты,
// чтобы понять пользу подробнее, а не просто прочитать список слов.
export const SUBSCRIPTION_BENEFITS = [
  {
    title: "Безлимитная пересборка плана",
    short: "Меняйте магазин, бюджет или просто пересобирайте заново — без ограничений",
    detail: "На бесплатном тарифе — 1 план в неделю. С подпиской ограничения нет вообще.",
  },
  {
    title: "Несколько планов одновременно",
    short: "Свой план, план для родителей, план на праздник — раздельно",
    // Живой вывод из ревью в чате: текст говорил "можно будет" (обещание на
    // будущее), хотя это уже реально работает — можно держать до 3 планов
    // и переключаться между ними чипами над списком покупок (см. PlanSlotsBar).
    detail: "На бесплатном тарифе активен только один план — «заново» стирает предыдущий. С Pro можно держать до 3 планов одновременно и переключаться между ними одним тапом, не теряя ни один.",
  },
  {
    title: "Напоминания от бота",
    short: "Бот сам напишет, когда пора готовить — не нужно открывать приложение",
    // Живой вывод из ревью в чате: текст говорил "уже в разработке, скоро
    // можно будет проверить", хотя напоминания уже реально отправляются
    // (см. server/src/scheduler.js) — просто раньше отправлялись вообще
    // всем, а не только Pro (см. findCandidateSlots в server/src/db.js,
    // теперь фильтрует по is_pro/pro_until). Текст обновлён на настоящее
    // время: это уже рабочая Pro-функция, а не обещание на будущее.
    detail: "За 30 минут до ужина (или другого приёма пищи) бот пришлёт сообщение с названием блюда прямо в чат — уже работает, доступно сразу после оформления Pro.",
  },
  {
    title: "Общий список на семью",
    short: "Отметил «уже есть дома» один — увидят все, до 6 человек",
    // Живой вывод из ревью в чате: текст обещал общий ПЛАН и "реальное
    // время" — по факту делится общим "уже есть дома" (см. AccountView:
    // FamilySection, server/src/family.js), а обновление приходит при
    // следующем открытии списка, не мгновенным пушем на чужой открытый
    // экран (нет вебсокетов/пушей — сознательный компромисс сложности vs
    // пользы, честно не обещаем то, чего нет).
    detail: "Пригласите семью (Аккаунт → «Общий список на семью») — отметил кто-то товар как «уже есть дома», остальные увидят это при следующем открытии списка покупок. Меньше дублирующихся покупок. Работает, пока у создателя семьи активен Pro.",
  },
];

// Полноэкранный продающий экран подписки — открывается кнопкой "Перейти на
// Pro" из Аккаунта. Пользователь в чате прямо описал желаемую механику:
// зачёркнутая старая цена рядом с новой (классический якорь цены) + кнопка
// оформления. Сама оплата пока никуда не ведёт по-настоящему — ни один
// провайдер не подключён (см. комментарий у SUBSCRIPTION_BENEFITS выше) —
// нажатие честно говорит "скоро", а не притворяется, что списало деньги.
// paymentState: "idle" | "loading" | "error". Реальная оплата — ЮKassa
// (POST /api/pay/create на бэкенде создаёт платёж, возвращает checkout-
// ссылку); "error" отдельно от простого возврата к "idle" — пользователь
// должен увидеть, что что-то пошло не так, а не просто снова увидеть
// исходную кнопку без объяснений.
export function ProModal({ onClose }) {
  const [paymentState, setPaymentState] = useState("idle");
  // Причина отказа — видна прямо в интерфейсе, не только в console.warn.
  // Долгая жалоба в чате дошла до диагностики подключения (Аккаунт — там
  // всё оказалось в порядке) и до логов на сервере (тоже пусто) — и всё
  // равно осталось неясно, что произошло. Показывать причину сразу под
  // кнопкой — следующий круг диагностики не должен снова упираться в
  // "а в логах пусто", достаточно посмотреть на сам экран. Именно так и
  // нашёлся настоящий корень: "Receipt is missing or illegal" — магазин
  // требует чек с email покупателя на каждый платёж (54-ФЗ), а Telegram
  // email не даёт вообще ни при каких условиях, см. lib/payerContact.js.
  const [errorDetail, setErrorDetail] = useState(null);
  const [email, setEmail] = useState(loadPayerEmail);
  const [agreed, setAgreed] = useState(loadConsent);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canPay = emailValid && agreed;
  const handleSubscribe = async () => {
    if (!canPay) return; // кнопка и так задизейблена — подстраховка от гонки
    saveConsent();
    hapticImpact("light");
    trackEvent("pro_subscribe_clicked");
    setPaymentState("loading");
    setErrorDetail(null);

    const trimmedEmail = email.trim();
    savePayerEmail(trimmedEmail);
    const result = await createProPayment(trimmedEmail);
    if (!result.ok) {
      hapticNotify("error");
      setPaymentState("error");
      setErrorDetail(result.detail || result.reason);
      return;
    }
    const { confirmationUrl } = result;

    hapticNotify("success");
    // openLink — официальный способ открыть внешнюю https-ссылку из Mini App
    // (обычный window.open в некоторых клиентах может не сработать); ЮKassa
    // не встраивается в WebView мини-приложения, оплата всегда идёт во
    // внешнем браузере/системном окне, тот же принцип, что и у SUPPORT_URL
    // чуть выше в файле. Статус подписки подтянется сам при следующем
    // открытии Аккаунта (checkPlanStatus) — отдельный опрос "оплатили ли уже"
    // не заводим, это и есть уже существующий механизм.
    window.Telegram?.WebApp?.openLink ? window.Telegram.WebApp.openLink(confirmationUrl) : window.open(confirmationUrl, "_blank");
    onClose();
  };
  return (
    <div style={styles.modalOverlay} className="modal-overlay-in" onClick={onClose}>
      <div style={styles.modalCard} className="modal-card-in" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} title="Закрыть" aria-label="Закрыть" style={styles.modalClose}>
          <X size={16} />
        </button>

        <div style={styles.proHero}>
          <Sparkles size={32} color={ACCENT} />
        </div>
        <h2 style={{ ...styles.stepTitle, textAlign: "center" }}>Съедим Pro</h2>
        <p style={{ ...styles.stepSub, textAlign: "center" }}>Всё то же самое, что уже работает, — но без ограничений</p>

        <div style={styles.stack}>
          {SUBSCRIPTION_BENEFITS.map((b) => (
            <div key={b.title} style={styles.proFeatureRow}>
              <div style={styles.proFeatureCheck}>
                <Check size={13} color={ACCENT} />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{b.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2, lineHeight: 1.4 }}>{b.detail}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={styles.proPriceBox}>
          <div style={styles.proPriceRow}>
            <span style={styles.proPriceNew}>{PRO_PRICE_RUB} ₽</span>
            <span style={styles.proPricePeriod}>за 30 дней</span>
          </div>
          {/* Зачёркнутая "399 ₽" убрана (UX-аудит 29.09.2026): по ней никогда
              не продавали — это вводящая в заблуждение реклама. "/ мес" и
              "подписка" тоже намекали на автосписание, которого нет (см.
              terms.html: разовый платёж на 30 дней). */}
          <p style={{ ...styles.acctSectionHint, textAlign: "center", margin: "4px 0 0 0" }}>
            Разовый платёж — автосписания нет, продлевать или нет решаете вы.
          </p>
          {/* Обязателен для чека (54-ФЗ, см. lib/payerContact.js) — ЮKassa
              без email/телефона покупателя отклоняет платёж целиком.
              Запоминается локально, при следующей оплате спрашивать не нужно. */}
          <div style={{ ...styles.acctLabel, marginTop: 12, textAlign: "left" }}>Email для чека</div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="you@example.com"
            enterKeyHint="done"
            autoComplete="email"
            style={styles.textInput}
          />
          <p style={{ ...styles.acctSectionHint, margin: "6px 0 0 0" }}>Нужен по закону — на него ЮKassa пришлёт кассовый чек.</p>
          <ConsentCheckbox checked={agreed} onChange={setAgreed} />
          <button
            onClick={handleSubscribe}
            disabled={paymentState === "loading" || !canPay}
            style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center", marginTop: 12, opacity: paymentState === "loading" || !canPay ? 0.6 : 1 }}
          >
            {paymentState === "loading" ? <><Loader2 size={16} className="spin" /> Готовим оплату…</> : `Оплатить Pro — ${PRO_PRICE_RUB} ₽`}
          </button>
          {paymentState === "error" && (
            <p style={{ ...styles.acctSectionHint, textAlign: "center", margin: "12px 0 0 0" }}>
              Не удалось начать оплату. Попробуйте ещё раз через минуту — если не поможет, напишите в поддержку (Аккаунт → «Написать в поддержку»).
              {errorDetail && <><br /><span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }}>{errorDetail}</span></>}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// "Ещё один план на этой неделе" — разовая дешёвая покупка, ступенька перед
// полной подпиской (живой вывод из ревью в чате: "многим проще заплатить
// один раз 50-70 ₽, чем сразу оформить месячную подписку"). Сильно короче
// ProModal выше — не продающий экран с перечислением всех Pro-плюшек, а
// быстрая одноразовая покупка ровно того, что нужно прямо сейчас. email —
// тот же email для чека (54-ФЗ), что и у Pro, см. lib/payerContact.js.
export function ExtraPlanModal({ onClose, onOpenPro }) {
  const [paymentState, setPaymentState] = useState("idle");
  const [errorDetail, setErrorDetail] = useState(null);
  const [email, setEmail] = useState(loadPayerEmail);
  const [agreed, setAgreed] = useState(loadConsent);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canPay = emailValid && agreed;

  const handleBuy = async () => {
    if (!canPay) return;
    saveConsent();
    hapticImpact("light");
    trackEvent("extra_plan_buy_clicked");
    setPaymentState("loading");
    setErrorDetail(null);

    const trimmedEmail = email.trim();
    savePayerEmail(trimmedEmail);
    const result = await createExtraPlanPayment(trimmedEmail);
    if (!result.ok) {
      hapticNotify("error");
      setPaymentState("error");
      setErrorDetail(result.detail || result.reason);
      return;
    }
    hapticNotify("success");
    window.Telegram?.WebApp?.openLink ? window.Telegram.WebApp.openLink(result.confirmationUrl) : window.open(result.confirmationUrl, "_blank");
    onClose();
  };

  return (
    <div style={styles.modalOverlay} className="modal-overlay-in" onClick={onClose}>
      <div style={styles.modalCard} className="modal-card-in" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} title="Закрыть" aria-label="Закрыть" style={styles.modalClose}>
          <X size={16} />
        </button>

        <div style={styles.proHero}>
          <Sparkles size={32} color={ACCENT} />
        </div>
        <h2 style={{ ...styles.stepTitle, textAlign: "center" }}>Ещё один план</h2>
        <p style={{ ...styles.stepSub, textAlign: "center" }}>
          Разовая покупка, без подписки — добавляет ровно один план сверх бесплатного лимита. Не сгорает: можно использовать, когда понадобится.
        </p>

        <div style={styles.proPriceBox}>
          <div style={styles.proPriceRow}>
            <span style={styles.proPriceNew}>{EXTRA_PLAN_PRICE_RUB} ₽</span>
            <span style={styles.proPricePeriod}>разово</span>
          </div>
          <div style={{ ...styles.acctLabel, marginTop: 12, textAlign: "left" }}>Email для чека</div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            placeholder="you@example.com"
            enterKeyHint="done"
            autoComplete="email"
            style={styles.textInput}
          />
          <p style={{ ...styles.acctSectionHint, margin: "6px 0 0 0" }}>Нужен по закону — на него ЮKassa пришлёт кассовый чек.</p>
          <ConsentCheckbox checked={agreed} onChange={setAgreed} />
          <button
            onClick={handleBuy}
            disabled={paymentState === "loading" || !canPay}
            style={{ ...styles.navBtnPrimary, width: "100%", justifyContent: "center", marginTop: 12, opacity: paymentState === "loading" || !canPay ? 0.6 : 1 }}
          >
            {paymentState === "loading" ? <><Loader2 size={16} className="spin" /> Готовим оплату…</> : "Купить план"}
          </button>
          {paymentState === "error" && (
            <p style={{ ...styles.acctSectionHint, textAlign: "center", margin: "12px 0 0 0" }}>
              Не удалось начать оплату. Попробуйте ещё раз через минуту — если не поможет, напишите в поддержку (Аккаунт → «Написать в поддержку»).
              {errorDetail && <><br /><span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }}>{errorDetail}</span></>}
            </p>
          )}
        </div>
        <button onClick={onOpenPro} style={{ ...styles.linkBtn, width: "100%", textAlign: "center", marginTop: 14 }}>
          Или оформить Pro — без ограничений вообще
        </button>
      </div>
    </div>
  );
}
