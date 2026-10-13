// Строка, которую можно потянуть вправо, чтобы удалить (как в списках iOS).
// Сама ничего не удаляет: дотянули дальше порога — просит onDelete, а подтверждение и
// удаление остаются за вызывающим. Вертикальная прокрутка не мешает: touch-action: pan-y
// оставляет браузеру только вертикальные жесты, горизонтальные достаются нам.

import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { hapticSelect } from "../../lib/haptics.js";

export const SWIPE_DELETE_THRESHOLD_PX = 72;
const SWIPE_MAX_PX = 110;
const AXIS_LOCK_PX = 8;

export function SwipeToDelete({ onDelete, label = "Удалить", children }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef(null); // { x, y, horizontal: null | bool }
  const swiped = useRef(false); // после протяжки мышью браузер шлёт click — гасим его

  const onPointerDown = (e) => {
    start.current = { x: e.clientX, y: e.clientY, horizontal: null };
  };
  const onPointerMove = (e) => {
    const s = start.current;
    if (!s) return;
    const moveX = e.clientX - s.x;
    const moveY = e.clientY - s.y;
    if (s.horizontal === null) {
      if (Math.abs(moveX) < AXIS_LOCK_PX && Math.abs(moveY) < AXIS_LOCK_PX) return;
      s.horizontal = Math.abs(moveX) > Math.abs(moveY);
      if (s.horizontal) setDragging(true);
    }
    if (s.horizontal) setDx(Math.max(0, Math.min(SWIPE_MAX_PX, moveX)));
  };
  const finish = () => {
    const s = start.current;
    start.current = null;
    const passed = s?.horizontal && dx >= SWIPE_DELETE_THRESHOLD_PX;
    swiped.current = !!s?.horizontal;
    setDragging(false);
    setDx(0);
    if (passed) { hapticSelect(); onDelete(); }
  };

  return (
    <div style={{ position: "relative", borderRadius: 18, overflow: "hidden" }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 8, paddingLeft: 18,
          background: "var(--danger)", color: "#fff", fontSize: 14, fontWeight: 600,
          opacity: dx > 0 ? 1 : 0,
        }}
      >
        <Trash2 size={18} /> {label}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onClickCapture={(e) => { if (swiped.current) { swiped.current = false; e.stopPropagation(); e.preventDefault(); } }}
        style={{
          position: "relative", touchAction: "pan-y",
          transform: `translateX(${dx}px)`,
          transition: dragging ? "none" : "transform .2s ease",
        }}
      >
        {children}
      </div>
    </div>
  );
}
