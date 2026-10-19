// Необязательный вопрос под первым планом: откуда человек узнал о «Съедим». Закрывается крестиком; после ответа
// или закрытия больше не показывается (см. lib/acquisition.js).
import { X } from "lucide-react";
import { styles, T } from "../styles.js";
import { hapticSelect } from "../lib/haptics.js";
import { ACQUISITION_OPTIONS } from "../lib/acquisition.js";

export function AcquisitionCard({ onAnswer, onClose }) {
  return (
    <div style={{ ...styles.subCard, marginTop: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: T.body }}>Откуда вы о нас узнали?</div>
          <div style={{ fontSize: T.caption, color: "var(--text-tertiary)", marginTop: 2 }}>Необязательно — это поможет понять, где рассказывать о «Съедим».</div>
        </div>
        <button onClick={onClose} title="Закрыть" aria-label="Закрыть вопрос" style={{ ...styles.subRevertBtn, flexShrink: 0 }}>
          <X size={13} />
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {ACQUISITION_OPTIONS.map((o) => (
          <button key={o.id} type="button" className="chip" onClick={() => { hapticSelect(); onAnswer(o); }} style={styles.pillChip(false)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
