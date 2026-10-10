// Выбор нелюбимых продуктов: готовые варианты + своё слово. Используется в визарде (шаг «Аллергии») и в Аккаунте.
// Это мягкое предпочтение — в отличие от аллергий, его могут смягчить, если подходящих рецептов мало.
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { styles } from "../styles.js";
import { hapticSelect } from "../lib/haptics.js";
import { DISLIKE_PRESETS, MAX_CUSTOM_DISLIKES, dislikeLabel, isPresetDislike, normalizeDislike } from "../lib/dislikes.js";

export function DislikesPicker({ dislikes, setDislikes }) {
  const [draft, setDraft] = useState("");
  const customs = dislikes.filter((d) => !isPresetDislike(d));

  const toggle = (id) => {
    hapticSelect();
    setDislikes(dislikes.includes(id) ? dislikes.filter((d) => d !== id) : [...dislikes, id]);
  };
  const addCustom = () => {
    const word = normalizeDislike(draft);
    if (!word) return;
    setDraft("");
    if (dislikes.includes(word) || customs.length >= MAX_CUSTOM_DISLIKES) return;
    hapticSelect();
    setDislikes([...dislikes, word]);
  };

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {DISLIKE_PRESETS.map((p) => (
          <button key={p.id} type="button" className="chip" onClick={() => toggle(p.id)} style={styles.pillChip(dislikes.includes(p.id))}>
            {p.label}
          </button>
        ))}
        {customs.map((word) => (
          <button key={word} type="button" className="chip" onClick={() => toggle(word)} style={styles.pillChip(true)} aria-label={`Убрать: ${dislikeLabel(word)}`}>
            {dislikeLabel(word)} <X size={13} />
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
          placeholder="Другое: например, тыква"
          enterKeyHint="done"
          maxLength={30}
          style={{ ...styles.textInput, flex: 1 }}
          aria-label="Добавить нелюбимый продукт"
        />
        <button type="button" onClick={addCustom} disabled={!normalizeDislike(draft)} style={{ ...styles.pillChip(false), opacity: normalizeDislike(draft) ? 1 : 0.5 }} aria-label="Добавить">
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
