import { useRef, useState } from "react";
import { cn } from "./cn";
import { motion, softSpring, useReducedMotion } from "./motion";

/** 右侧面板的尺寸跟随指针；弹性仅用于把手，避免正文随拖拽变形。 */
export function PanelResizeHandle({
  label,
  value,
  min,
  max,
  onChange,
  onReset,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onReset?: () => void;
  className?: string;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [bend, setBend] = useState(0);
  const [active, setActive] = useState(false);
  const reduced = useReducedMotion();
  const resize = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  const end = () => {
    drag.current = null;
    setBend(0);
    setActive(false);
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: value };
        setActive(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const delta = event.clientX - drag.current.x;
        resize(drag.current.width - delta);
        setBend(Math.max(-9, Math.min(9, delta / 8)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "Escape") {
          end();
          onReset?.();
        } else
          resize(
            event.key === "Home"
              ? min
              : event.key === "End"
                ? max
                : value + (event.key === "ArrowLeft" ? 24 : -24),
          );
      }}
      className={cn(
        "group absolute inset-y-0 -left-2 z-20 hidden w-4 touch-none cursor-col-resize select-none items-center justify-center outline-none xl:flex",
        className,
      )}
    >
      <svg
        width="24"
        height="80"
        viewBox="0 0 24 80"
        aria-hidden="true"
        className={cn(
          "shrink-0 overflow-visible text-border-strong transition-colors group-hover:text-brand group-focus-visible:text-brand",
          active && "text-brand",
        )}
      >
        <motion.path
          d="M12 18 Q12 40 12 62"
          animate={{ d: `M12 18 Q${12 + (reduced ? 0 : bend)} 40 12 62` }}
          transition={softSpring}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
