// Раздел «Общий список на семью» в Аккаунте.

import { Users, Share2 } from "lucide-react";
import { trackEvent } from "../../lib/analytics.js";
import { hapticImpact } from "../../lib/haptics.js";
import { styles, ACCENT } from "../../styles.js";
import { pluralPeople } from "../../lib/format.js";
import { BOT_SHARE_URL, shareViaTelegram } from "../../lib/share.js";

// Живой вывод из ревью Pro-плюшек (чат): "Общий список на семью"
// рекламировался, а по факту не существовал вообще. Дублирует
// MAX_FAMILY_MEMBERS из server/src/family.js — тот же принцип, что и у
// REFERRAL_REWARD_DAYS_LABEL выше (цифра для текста на фронтенде неизбежно
// живёт отдельной строкой от источника истины на сервере). Название секции
// в Аккаунте — намеренно НЕ "Семья" (эта подпись уже занята счётчиком "на
// скольких человек считать план" в "Профиль для плана" выше) — чтобы не
// путать два разных смысла одного слова.
export const MAX_FAMILY_MEMBERS_LABEL = 6;

export function FamilySection({ familyStatus, isPro, actionState, onCreate, onLeave, onOpenPro }) {
  // Вне Telegram (обычный браузер) initDataUnsafe.user не существует —
  // ссылка вида "?startapp=fam_undefined" никуда не привела бы осмысленно,
  // тот же принцип, что и у ReferralSection ниже.
  const myTelegramId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
  if (!myTelegramId || familyStatus === null) return null; // ещё не спрашивали/бэкенд недоступен — честнее не показывать, чем нерабочую заглушку

  if (!familyStatus.inFamily) {
    if (!isPro) return null; // сам бонус уже описан в карточке подписки/ProModal — не дублируем нерабочую кнопку для тех, кому ещё нечем ей воспользоваться
    return (
      <div style={styles.acctSection}>
        <div style={styles.subCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <Users size={16} color={ACCENT} />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Общий список на семью</span>
          </div>
          <p style={styles.acctSectionHint}>
            Пригласите до {MAX_FAMILY_MEMBERS_LABEL} человек — отметил кто-то из семьи "уже есть дома", увидят все остальные.
          </p>
          <button
            onClick={onCreate}
            disabled={actionState.status === "loading"}
            style={{ ...styles.orderBtn, marginTop: 4, opacity: actionState.status === "loading" ? 0.6 : 1 }}
          >
            {actionState.status === "loading" ? "Создаём…" : "Создать семью"}
          </button>
          {actionState.status === "error" && <p style={styles.acctWarnHint}>{actionState.message}</p>}
        </div>
      </div>
    );
  }

  // inviteCode, не familyId — живая жалоба в чате: id семьи маленький и
  // предсказуемый (AUTOINCREMENT), можно перебрать и напроситься в чужую
  // семью. inviteCode — случайный (см. genInviteCode в server/src/db.js).
  const inviteLink = `${BOT_SHARE_URL}?startapp=fam_${familyStatus.inviteCode}`;
  // Текст приглашения не обещает "один и тот же список" (UX-аудит 29.09.2026):
  // у каждого свой план, общая только отметка "уже есть дома".
  const shareText = "Присоединяйся к нашей семье в «Съедим» — так мы не будем покупать одно и то же дважды: отметил дома продукт один — второй увидит это при следующем открытии списка.";
  return (
    <div style={styles.acctSection}>
      <div style={styles.subCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Users size={16} color={ACCENT} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>Общий список на семью</span>
        </div>
        {familyStatus.active === false ? (
          // Решение автора (30.09.2026): после окончания Pro у владельца семья
          // не остаётся — общий список на паузе, состав и данные сохранены.
          <>
            <p style={styles.acctWarnHint}>
              {familyStatus.isOwner
                ? "Семья на паузе: у вас закончился Pro, общий список не работает. Продлите Pro — и всё вернётся с того же места."
                : "Общий список на паузе: у владельца семьи закончился Pro. Когда владелец продлит Pro, список снова заработает."}
            </p>
            {familyStatus.isOwner ? (
              <button onClick={() => { hapticImpact("light"); onOpenPro?.(); }} style={{ ...styles.orderBtn, marginTop: 4 }}>
                Продлить Pro
              </button>
            ) : (
              // Участнику самому нечем помочь, но может напомнить владельцу.
              <button
                onClick={() => { hapticImpact("light"); trackEvent("family_remind_owner"); shareViaTelegram("Наш общий список в «Съедим» на паузе — у тебя закончился Pro. Продли, пожалуйста, и список снова заработает.", BOT_SHARE_URL); }}
                style={{ ...styles.orderBtn, marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                <Share2 size={15} /> Напомнить владельцу
              </button>
            )}
          </>
        ) : (
          <p style={styles.acctSectionHint}>
            {familyStatus.members.length} {pluralPeople(familyStatus.members.length)} — общий "уже есть дома" в списке покупок.
          </p>
        )}
        <div style={styles.stack}>
          {familyStatus.members.map((m) => (
            <div key={m.telegramUserId} style={styles.familyMemberRow}>
              {m.displayName || "Участник"}
              {m.telegramUserId === myTelegramId ? " (вы)" : ""}
            </div>
          ))}
        </div>
        {familyStatus.active !== false && familyStatus.isOwner && familyStatus.members.length < MAX_FAMILY_MEMBERS_LABEL && (
          <button
            onClick={() => { hapticImpact("light"); trackEvent("family_invite_shared"); shareViaTelegram(shareText, inviteLink); }}
            style={{ ...styles.orderBtn, marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            <Share2 size={15} /> Пригласить ещё
          </button>
        )}
        <button onClick={onLeave} disabled={actionState.status === "loading"} style={styles.acctClearBtn}>
          {actionState.status === "loading" ? "Выходим…" : familyStatus.isOwner ? "Распустить семью" : "Покинуть семью"}
        </button>
        {actionState.status === "error" && <p style={styles.acctWarnHint}>{actionState.message}</p>}
      </div>
    </div>
  );
}
