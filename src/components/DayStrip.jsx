// Полоса дней над рецептами недели (Пн–Вс): нажатие прокручивает к нужному дню, подсвечен день, который сейчас
// на экране; «сегодня» отмечен рамкой. Раньше неделя из 14 приёмов пищи читалась одной длинной прокруткой.
import { useEffect, useRef, useState } from "react";
import { styles } from "../styles.js";
import { hapticSelect } from "../lib/haptics.js";
import { describePlanDay } from "../lib/planDays.js";

export const dayBlockId = (day) => `plan-day-${day}`;
// Линия под липкой полосой: день считается «текущим», когда его блок дошёл до неё.
const ACTIVE_LINE_PX = 110;

export function DayStrip({ days, planStartISO }) {
  const infos = days.map(({ day }) => ({ day, info: describePlanDay(planStartISO, day) }));
  const todayDay = infos.find((d) => d.info?.isToday)?.day ?? days[0]?.day;
  const [activeDay, setActiveDay] = useState(todayDay);
  // «Прилипла» ли полоса к верху экрана. Пока она на своём месте — просто ряд кнопок без подложки; подложка
  // (матовая плашка с тенью) появляется только когда под полосой едет текст, чтобы он не сливался с кнопками.
  const sentinel = useRef(null);
  const [stuck, setStuck] = useState(false);

  // Какой день сейчас вверху экрана: последний, чей блок уже дошёл до линии под полосой (ниже недели ещё идёт
  // список покупок, так что до линии доходит и последний день). Считаем по положению блоков при прокрутке: так
  // работает и вверх, и вниз, и без IntersectionObserver (старые WebView).
  const lockUntil = useRef(0);
  useEffect(() => {
    const compute = () => {
      const top = sentinel.current?.getBoundingClientRect().top;
      if (top != null) setStuck((prev) => { const next = top < -1; return prev === next ? prev : next; });
      if (Date.now() < lockUntil.current) return; // идёт прокрутка после нажатия — не перебиваем выбранный день
      let current = days[0]?.day;
      let anyBlock = false;
      for (const { day } of days) {
        const el = document.getElementById(dayBlockId(day));
        if (!el) continue;
        anyBlock = true;
        if (el.getBoundingClientRect().top <= ACTIVE_LINE_PX) current = day;
      }
      if (!anyBlock) return; // блоков дней ещё нет в документе — оставляем как есть
      setActiveDay((prev) => (prev === current ? prev : current));
    };
    // Без троттлинга: семь замеров положения — копейки, а rAF/таймеры в фоновых вкладках притормаживают.
    window.addEventListener("scroll", compute, { passive: true });
    compute();
    return () => window.removeEventListener("scroll", compute);
  }, [days]);

  const jump = (day) => {
    hapticSelect();
    setActiveDay(day);
    lockUntil.current = Date.now() + 900;
    document.getElementById(dayBlockId(day))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (days.length < 2) return null;
  return (
    <>
    <div ref={sentinel} aria-hidden="true" style={{ height: 0 }} />
    <nav aria-label="Дни недели" className="day-strip" style={{ ...styles.dayStrip, ...(stuck ? styles.dayStripStuck : null) }}>
      {infos.map(({ day, info }) => {
        const active = activeDay === day;
        return (
          <button
            key={day}
            type="button"
            onClick={() => jump(day)}
            aria-label={info ? `Перейти к дню: ${info.label}` : `Перейти ко дню ${day}`}
            aria-current={active ? "true" : undefined}
            style={{ ...styles.dayChip(active, !!info?.isToday), opacity: info?.isPast && !active ? 0.55 : 1 }}
          >
            <span style={{ fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", opacity: 0.85 }}>{info ? info.weekday : "день"}</span>
            <span style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>{info ? info.dayOfMonth : day}</span>
          </button>
        );
      })}
    </nav>
    </>
  );
}
