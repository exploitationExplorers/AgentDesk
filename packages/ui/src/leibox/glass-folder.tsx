import { useEffect, useId, useRef, type CSSProperties } from "react";
import { cn } from "../cn";

const BACK_PATH =
  "M0 56A22 22 0 0 1 22 34L146 34C170 34 172 0 198 0L318 0A22 22 0 0 1 340 22L340 250A22 22 0 0 1 318 272L22 272A22 22 0 0 1 0 250Z";
const FRONT_PATH =
  "M0 22A22 22 0 0 1 22 0L118 0C144 0 146 32 172 32L318 32A22 22 0 0 1 340 54L340 176A22 22 0 0 1 318 198L22 198A22 22 0 0 1 0 176Z";
const MAX_VISIBLE = 6;
const LINE_WIDTHS = [86, 92, 64, 88, 42];

export type GlassFolderItem = {
  id: string;
  name: string;
  meta?: string;
};

function fanSlot(index: number, count: number) {
  return count <= 1 ? 0 : (index / (count - 1)) * 2 - 1;
}

function jitter(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const n = (h >>> 0) / 4294967296;
  return { x: ((n - 0.5) * 10).toFixed(2), r: ((n * 0.7 - 0.35) * 3.2).toFixed(2) };
}

/** LeiBox 玻璃文件夹：受控展开，扇出业务条目；省略演示画布与三栏沙盒。 */
export function GlassFolder({
  label,
  open,
  onOpenChange,
  items,
  selectedId,
  onSelect,
  tone = "auto",
  scale = 0.78,
  className,
  emptyText = "暂无项目",
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: GlassFolderItem[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  tone?: "light" | "dark" | "auto";
  scale?: number;
  className?: string;
  emptyText?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const filesId = useId();
  // 项目选择优先展示列表前部；超出部分后续可接搜索，避免演示式只露末尾。
  const visible = items.slice(0, MAX_VISIBLE);
  const resolvedTone =
    tone === "auto"
      ? typeof document !== "undefined" && document.documentElement.classList.contains("dark")
        ? "dark"
        : "light"
      : tone;

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mark = () => {
      node.dataset.entered = "";
    };
    if (reduce) {
      mark();
      return;
    }
    const timer = window.setTimeout(mark, 40);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let px = 0;
    let py = 0;
    const write = () => {
      frame = 0;
      node.style.setProperty("--gf-px", px.toFixed(3));
      node.style.setProperty("--gf-py", py.toFixed(3));
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || media.matches) return;
      const bounds = node.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      px = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      py = ((event.clientY - bounds.top) / bounds.height) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(write);
    };
    const onLeave = () => {
      px = py = 0;
      if (!frame) frame = requestAnimationFrame(write);
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={root}
      data-leibox="glass-folder"
      data-tone={resolvedTone}
      data-open={open ? "" : undefined}
      className={cn("gf-root", className)}
      style={{ "--gf-scale": String(scale) } as CSSProperties}
    >
      <div className="gf-stage">
        <div className="gf-tilt">
          <div className="gf-shadow" aria-hidden="true" />
          <div className="gf-back" style={{ clipPath: `path('${BACK_PATH}')` }}>
            <div className="gf-art" aria-hidden="true" />
            <div className="gf-back-sheen" aria-hidden="true" />
          </div>
          <svg className="gf-rim gf-back-rim" viewBox="0 0 340 272" aria-hidden="true">
            <path d={BACK_PATH} />
          </svg>
          <div
            id={filesId}
            className="gf-files"
            role="list"
            aria-label={`${label} 内容`}
            {...(!open ? { inert: true } : {})}
          >
            {visible.map((item, index) => {
              const slot = fanSlot(index, visible.length);
              const depth = visible.length - 1 - index;
              const shake = jitter(`${item.id}:${item.name}`);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="listitem"
                  className="gf-sheet"
                  aria-pressed={selectedId === item.id}
                  aria-label={`选择 ${item.name}`}
                  style={
                    {
                      zIndex: index + 1,
                      "--gf-slot": slot,
                      "--gf-depth": depth,
                      "--gf-jx": `${shake.x}px`,
                      "--gf-jr": `${shake.r}deg`,
                    } as CSSProperties
                  }
                  onClick={() => {
                    onSelect(item.id);
                    onOpenChange(false);
                  }}
                >
                  <span className="gf-lines" aria-hidden="true">
                    {LINE_WIDTHS.map((width) => (
                      <i key={width} style={{ width: `${width}%` }} />
                    ))}
                  </span>
                  <span className="gf-sheet-head">
                    <span className="gf-sheet-name">{item.name}</span>
                    {item.meta ? <span className="gf-sheet-meta">{item.meta}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
          {!items.length ? <p className="gf-empty">{emptyText}</p> : null}
          <div className="gf-front" style={{ clipPath: `path('${FRONT_PATH}')` }}>
            <div className="gf-tint" aria-hidden="true" />
            <div className="gf-spec" aria-hidden="true" />
            <svg className="gf-rim gf-front-rim" viewBox="0 0 340 198" aria-hidden="true">
              <path d={FRONT_PATH} stroke="rgba(255,255,255,0.55)" />
            </svg>
            <button
              type="button"
              className="gf-hit"
              aria-expanded={open}
              aria-controls={filesId}
              aria-label={`${open ? "收起" : "展开"} ${label}，${items.length} 项`}
              onClick={() => onOpenChange(!open)}
            />
            <div className="gf-label">
              <span className="gf-title">{label}</span>
              <span className="gf-meta">
                {items.length} {items.length === 1 ? "item" : "items"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
