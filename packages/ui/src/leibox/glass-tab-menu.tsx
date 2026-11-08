import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../cn";

/** LeiBox Glass Tab Menu 的选中块弹簧；按真实 DOM 尺寸适配横向/纵向导航。 */
export function GlassSelection({ selector, className }: { selector: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const indicator = ref.current;
    const root = indicator?.parentElement;
    if (!indicator || !root) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const states = Array.from({ length: 4 }, () => ({ p: 0, v: 0, target: 0 }));
    let frame = 0;
    let last = 0;
    let initialized = false;
    const draw = () => {
      const [x, y, width, height] = states.map((state) => state.p);
      indicator.style.transform = `translate3d(${x}px,${y}px,0)`;
      indicator.style.width = `${Math.max(0, width ?? 0)}px`;
      indicator.style.height = `${Math.max(0, height ?? 0)}px`;
      const travel = Math.min(1, Math.hypot(states[0]!.v, states[1]!.v) / 1300);
      indicator.style.setProperty("--lb-travel", String(travel));
    };
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = last = 0;
      for (const state of states) {
        state.p = state.target;
        state.v = 0;
      }
      draw();
    };
    const tick = (time: number) => {
      frame = 0;
      if (media.matches || document.hidden) {
        settle();
        return;
      }
      const dt = Math.min(0.032, (time - (last || time - 16)) / 1000);
      last = time;
      let moving = false;
      // 保留上游 330/26 弹簧和三次积分，移除演示页固定的 183px 步长。
      for (let i = 0; i < 3; i++) {
        for (const state of states) {
          const h = dt / 3;
          state.v += ((state.target - state.p) * 330 - state.v * 26) * h;
          state.p += state.v * h;
          if (Math.abs(state.p - state.target) < 0.05 && Math.abs(state.v) < 0.05) {
            state.p = state.target;
            state.v = 0;
          } else moving = true;
        }
      }
      draw();
      if (moving) frame = requestAnimationFrame(tick);
      else last = 0;
    };
    const measure = () => {
      const selected = root.querySelector<HTMLElement>(selector);
      if (!selected) {
        indicator.style.opacity = "0";
        return;
      }
      const box = selected.getBoundingClientRect();
      const container = root.getBoundingClientRect();
      const next = [
        box.left - container.left + root.scrollLeft - root.clientLeft,
        box.top - container.top + root.scrollTop - root.clientTop,
        box.width,
        box.height,
      ];
      states.forEach((state, index) => {
        state.target = next[index]!;
      });
      indicator.style.opacity = "1";
      if (!initialized || media.matches || document.hidden) {
        initialized = true;
        settle();
      } else if (!frame) frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(measure);
    const observeItems = () => {
      resize.disconnect();
      resize.observe(root);
      root.querySelectorAll("button,a,[role=tab]").forEach((item) => resize.observe(item));
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) observeItems();
      measure();
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-pressed", "aria-selected", "aria-current", "data-state", "class"],
    });
    observeItems();
    measure();
    media.addEventListener("change", measure);
    document.addEventListener("visibilitychange", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      media.removeEventListener("change", measure);
      document.removeEventListener("visibilitychange", measure);
    };
  }, [selector]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-leibox="glass-selection"
      className={cn("lb-selection", className)}
    />
  );
}

export function GlassTabMenu<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-leibox="glass-tab-menu"
      className={cn("lb-glass lb-tab-menu ad-segmented", className)}
    >
      <GlassSelection selector="[aria-pressed=true]" />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className="lb-tab"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
