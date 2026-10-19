// Мелкие общие части экранов: оболочка шага, скелетон, закрываемая заметка, галочка согласия.

import { useEffect, useState } from "react";
import { TriangleAlert, Info, X } from "lucide-react";
import { openLegalPage } from "../lib/consent.js";
import { styles } from "../styles.js";

export function StepShell({ icon, title, sub, children }) {
  return (
    <div className="fade-in-up">
      <div style={styles.stepIcon}>{icon}</div>
      <h2 style={styles.stepTitle}>{title}</h2>
      <p style={styles.stepSub}>{sub}</p>
      {children}
    </div>
  );
}

// Этапы сборки плана. Привязаны ко времени, а не к настоящему прогрессу (его у нас нет): смена
// подписи показывает, что работа идёт, и ничего не обещает про проценты. Последний этап держится до конца.
export const ASSEMBLING_STAGES = [
  "Подбираем рецепты под ваш бюджет…",
  "Ищем продукты в каталоге…",
  "Считаем цены…",
  "Собираем список покупок…",
];
export const ASSEMBLING_STAGE_MS = 3000;
const BASKET_FOOD = ["🥕", "🍅", "🥛", "🍞", "🧀"];

export function SkeletonView() {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (stage >= ASSEMBLING_STAGES.length - 1) return undefined;
    const t = setTimeout(() => setStage((n) => n + 1), ASSEMBLING_STAGE_MS);
    return () => clearTimeout(t);
  }, [stage]);

  return (
    <div style={styles.stepBody} className="fade-in-up mp-skeleton-body">
      <div style={styles.assembleStage} aria-hidden="true">
        {BASKET_FOOD.map((emoji, i) => (
          <span key={emoji} className="basket-drop" style={{ "--from": `${14 + i * 18}%`, animationDelay: `${i * 0.45}s` }}>{emoji}</span>
        ))}
        <span className="basket-body">🧺</span>
      </div>
      <div style={styles.assemblingCaption} role="status" aria-live="polite">
        <span key={stage} className="fade-in-up">{ASSEMBLING_STAGES[stage]}</span>
      </div>
      <div className="skeleton-bar" style={styles.skeletonBar(24, "65%")} />
      <div className="skeleton-bar" style={styles.skeletonBar(74)} />
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div className="skeleton-bar" style={styles.skeletonBar(11, "25%")} />
          <div className="skeleton-bar" style={styles.skeletonBar(38)} />
          <div className="skeleton-bar" style={styles.skeletonBar(38)} />
        </div>
      ))}
    </div>
  );
}

// tone="info" — нейтральная заметка («Запомнили…», «Вы вступили в семью…»): не жёлтая и без треугольника, чтобы сигнал
// «что-то не так» (tone="warning", по умолчанию) не обесценивался (аудит 19.10.2026).
export function DismissibleNote({ children, onClose, tone = "warning" }) {
  const info = tone === "info";
  const Icon = info ? Info : TriangleAlert;
  return (
    <div style={{ ...(info ? styles.infoBox : styles.warningBox), marginTop: 0 }}>
      <Icon size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ flex: 1 }}>{children}</span>
      <button onClick={onClose} title="Закрыть" aria-label="Закрыть" style={{ ...styles.subRevertBtn, color: "inherit", flexShrink: 0 }}>
        <X size={13} />
      </button>
    </div>
  );
}

// Согласие с условиями перед оплатой (см. lib/consent.js): без галочки кнопка
// оплаты неактивна. Ссылки открывают документы во внешнем браузере.
export function ConsentCheckbox({ checked, onChange }) {
  return (
    <label style={styles.consentRow}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={styles.consentBox} />
      <span>
        Я принимаю{" "}
        <button type="button" onClick={() => openLegalPage("terms.html")} style={styles.inlineLinkBtn}>пользовательское соглашение</button>
        {" "}и{" "}
        <button type="button" onClick={() => openLegalPage("privacy.html")} style={styles.inlineLinkBtn}>политику конфиденциальности</button>
      </span>
    </label>
  );
}
