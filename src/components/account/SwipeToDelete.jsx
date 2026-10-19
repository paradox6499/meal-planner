// Строка, которую можно потянуть в сторону, чтобы удалить (как в списках iOS): вправо или влево.
// Сама ничего не удаляет: дотянули дальше порога — просит onDelete, а подтверждение и удаление остаются за
// вызывающим.
//
// Касания — нативные touch-события с preventDefault: на iPhone Safari/Telegram сам решает, что жест
// вертикальная прокрутка или системный «назад», и отменяет pointer-события; React вешает touchmove как
// пассивный, поэтому слушатели повешены вручную с { passive: false }. Мышь (десктоп) идёт через pointer-события.

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { hapticSelect } from "../../lib/haptics.js";

export const SWIPE_DELETE_THRESHOLD_PX = 64;
const SWIPE_MAX_PX = 110;
const AXIS_LOCK_PX = 6;

export function SwipeToDelete({ onDelete, label = "Удалить", children }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const el = useRef(null);
  const gesture = useRef(null); // { x, y, horizontal: null | bool }
  const dxRef = useRef(0);
  const swiped = useRef(false); // после протяжки браузер шлёт click — гасим его
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;

  useEffect(() => {
    const node = el.current;
    if (!node) return undefined;

    const begin = (x, y) => { gesture.current = { x, y, horizontal: null }; };
    // Возвращает true, если жест горизонтальный (и значит, прокрутку надо запретить).
    const move = (x, y) => {
      const g = gesture.current;
      if (!g) return false;
      const moveX = x - g.x;
      const moveY = y - g.y;
      if (g.horizontal === null) {
        if (Math.abs(moveX) < AXIS_LOCK_PX && Math.abs(moveY) < AXIS_LOCK_PX) return false;
        g.horizontal = Math.abs(moveX) > Math.abs(moveY);
        if (g.horizontal) setDragging(true);
      }
      if (!g.horizontal) return false;
      dxRef.current = Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, moveX));
      setDx(dxRef.current);
      return true;
    };
    const end = () => {
      const g = gesture.current;
      gesture.current = null;
      const passed = !!g?.horizontal && Math.abs(dxRef.current) >= SWIPE_DELETE_THRESHOLD_PX;
      swiped.current = !!g?.horizontal;
      dxRef.current = 0;
      setDragging(false);
      setDx(0);
      if (passed) { hapticSelect(); onDeleteRef.current(); }
    };

    const onTouchStart = (e) => { const t = e.touches[0]; begin(t.clientX, t.clientY); };
    const onTouchMove = (e) => {
      const t = e.touches[0];
      if (move(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
    };
    const onPointerDown = (e) => { if (e.pointerType === "mouse") begin(e.clientX, e.clientY); };
    const onPointerMove = (e) => { if (e.pointerType === "mouse") move(e.clientX, e.clientY); };
    const onPointerUp = (e) => { if (e.pointerType === "mouse") end(); };
    const onClickCapture = (e) => {
      if (swiped.current) { swiped.current = false; e.stopPropagation(); e.preventDefault(); }
    };

    node.addEventListener("touchstart", onTouchStart, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", end);
    node.addEventListener("touchcancel", end);
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", onPointerUp);
    node.addEventListener("click", onClickCapture, true);
    return () => {
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", end);
      node.removeEventListener("touchcancel", end);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  const goingRight = dx > 0;
  return (
    <div style={{ position: "relative", borderRadius: 18, overflow: "hidden" }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", gap: 8,
          justifyContent: goingRight ? "flex-start" : "flex-end", padding: "0 18px",
          background: "var(--danger)", color: "#fff", fontSize: 14, fontWeight: 600,
          opacity: dx !== 0 ? 1 : 0,
        }}
      >
        <Trash2 size={18} /> {label}
      </div>
      <div
        ref={el}
        style={{
          position: "relative", touchAction: "pan-y", userSelect: "none", WebkitUserSelect: "none",
          transform: `translateX(${dx}px)`,
          transition: dragging ? "none" : "transform .2s ease",
        }}
      >
        {children}
      </div>
    </div>
  );
}
