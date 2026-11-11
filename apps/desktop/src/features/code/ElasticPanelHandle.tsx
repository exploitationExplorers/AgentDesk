import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@agentdesk/ui";

/**
 * Vertical elastic resize handle inspired by LeiBox elastic-panel-resize:
 * handle appears on hover, bends while dragging, rubber-bands past limits.
 * https://leibox.pantoria.cn/docs/animations/elastic-panel-resize
 */
export function ElasticPanelHandle({
  width,
  min = 148,
  max = 360,
  collapsed,
  onWidthChange,
  onCollapsedChange,
  onDraggingChange,
}: {
  width: number;
  min?: number;
  max?: number;
  collapsed: boolean;
  onWidthChange: (width: number) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const [hover, setHover] = useState(false);
  const [drag, setDrag] = useState<{
    startX: number;
    startWidth: number;
    raw: number;
    speed: number;
    time: number;
  } | null>(null);
  const [bend, setBend] = useState(0);
  const [offset, setOffset] = useState(0);
  const reduced = useRef(
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    onDraggingChange?.(Boolean(drag));
  }, [drag, onDraggingChange]);

  useEffect(() => {
    if (!drag) {
      setBend(0);
      setOffset(0);
      return;
    }
    const onMove = (event: PointerEvent) => {
      const now = performance.now();
      const dx = event.clientX - drag.startX;
      const next = Math.round(drag.startWidth + dx);
      const dt = Math.max(1, now - drag.time);
      const speed = ((event.clientX - (drag.raw + drag.startX - drag.startWidth)) / dt) * 16;
      const clamped = Math.max(min, Math.min(max, next));
      const excess = next - clamped;
      onWidthChange(Math.round(clamped));
      if (!reduced.current) {
        const pull = Math.min(1, Math.abs(excess) / 80);
        const direction = Math.max(-1, Math.min(1, speed / 50));
        setBend(direction * 4.2 * (1 - pull));
        setOffset(direction * 8 * (1 - pull) + Math.sign(excess) * 5 * pull);
      }
      setDrag({
        startX: drag.startX,
        startWidth: drag.startWidth,
        raw: next,
        speed,
        time: now,
      });
    };
    const onUp = () => setDrag(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, max, min, onWidthChange]);

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (collapsed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      startX: event.clientX,
      startWidth: width,
      raw: width,
      speed: 0,
      time: performance.now(),
    });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="ad-elastic-expand"
        aria-label="展开任务列表"
        title="展开任务列表"
        onClick={() => onCollapsedChange(false)}
      >
        <ChevronsRight size={14} />
      </button>
    );
  }

  const x = 40 + offset;
  const path = `M${x} ${80 - 36} Q${x + bend * 2} 80 ${x} ${80 + 36}`;
  const show = hover || Boolean(drag);

  return (
    <button
      type="button"
      className={cn("ad-elastic-handle", show && "is-visible", drag && "is-dragging")}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整任务列表宽度"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => !drag && setHover(false)}
      onPointerDown={start}
      onDoubleClick={() => onCollapsedChange(true)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onWidthChange(Math.max(min, width - 16));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onWidthChange(Math.min(max, width + 16));
        } else if (event.key === "Home") {
          event.preventDefault();
          onWidthChange(min);
        } else if (event.key === "End") {
          event.preventDefault();
          onWidthChange(max);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCollapsedChange(true);
        }
      }}
      title="拖动调整宽度 · 双击收起"
    >
      <svg viewBox="0 0 80 160" aria-hidden="true">
        <path className="ad-elastic-outline" d={path} />
        <path className="ad-elastic-ink" d={path} />
      </svg>
      <span className="ad-elastic-collapse" aria-hidden="true">
        <ChevronsLeft size={12} />
      </span>
    </button>
  );
}
