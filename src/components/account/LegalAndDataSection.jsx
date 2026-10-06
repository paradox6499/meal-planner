// Раздел «Документы и данные» в Аккаунте: ссылки на документы и удаление данных.

import { useState } from "react";
import { deleteAccount } from "../../lib/backend.js";
import { openLegalPage } from "../../lib/consent.js";
import { hapticImpact, hapticNotify } from "../../lib/haptics.js";
import { styles } from "../../styles.js";
import { confirmAction } from "../../lib/confirmAction.js";

// Документы и данные в конце Аккаунта (152-ФЗ): ссылки на политику и
// соглашение (раньше они были только на лендинге, внутри приложения — нигде) и
// право на удаление данных кнопкой, а не только письмом в поддержку.
export function LegalAndDataSection() {
  const [state, setState] = useState({ status: "idle" }); // idle | loading | error

  const handleDelete = async () => {
    const ok = await confirmAction(
      "Удалить все ваши данные из «Съедим»? Профиль, планы и история, напоминания, обращения и участие в семье будут стёрты без восстановления. Платный Pro и купленные планы тоже пропадут. Записи об оплатах сохраняются — этого требует закон."
    );
    if (!ok) return;
    hapticImpact("medium");
    // Событие аналитики перед удалением НЕ шлём: fire-and-forget запрос мог бы
    // долететь уже ПОСЛЕ удаления и создать строку удалённому пользователю.
    setState({ status: "loading" });
    const result = await deleteAccount();
    if (!result.ok) {
      hapticNotify("error");
      setState({ status: "error", message: result.error });
      return;
    }
    hapticNotify("success");
    // Локальные данные (профиль, планы, "уже есть дома", email для чека,
    // согласие) живут только на этом устройстве — стираем их тоже и
    // перезапускаем приложение с чистого листа.
    try { localStorage.clear(); } catch { /* нечего стирать */ }
    window.location.reload();
  };

  return (
    <div style={styles.acctSection}>
      <div style={styles.acctSectionTitle}>Документы и данные</div>
      {/* Крупная зона нажатия (высота ~44 px): раньше ссылки были высотой 14 px, на телефоне в них
          почти невозможно было попасть пальцем («кнопка не нажимается»). */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
        <button onClick={() => openLegalPage("privacy.html")} style={styles.legalLinkBtn}>Политика конфиденциальности</button>
        <button onClick={() => openLegalPage("terms.html")} style={styles.legalLinkBtn}>Пользовательское соглашение</button>
      </div>
      <button onClick={handleDelete} disabled={state.status === "loading"} style={{ ...styles.acctClearBtn, marginTop: 14 }}>
        {state.status === "loading" ? "Удаляем…" : "Удалить мои данные"}
      </button>
      {state.status === "error" && <p style={styles.acctWarnHint}>Не удалось удалить: {state.message}. Попробуйте ещё раз или напишите в поддержку.</p>}
    </div>
  );
}
