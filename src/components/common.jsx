// Мелкие общие части экранов: оболочка шага, скелетон, закрываемая заметка, галочка согласия.

import { Loader2, TriangleAlert, X } from "lucide-react";
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

export function SkeletonView() {
  return (
    <div style={styles.stepBody} className="fade-in-up mp-skeleton-body">
      <div style={styles.assemblingCaption}>
        <Loader2 size={15} className="spin" />
        Собираем план и список покупок…
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

export function DismissibleNote({ children, onClose }) {
  return (
    <div style={{ ...styles.warningBox, marginTop: 0 }}>
      <TriangleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ flex: 1 }}>{children}</span>
      <button onClick={onClose} title="Закрыть" aria-label="Закрыть" style={{ ...styles.subRevertBtn, flexShrink: 0 }}>
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
