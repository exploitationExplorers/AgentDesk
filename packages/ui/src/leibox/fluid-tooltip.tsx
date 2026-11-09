import { useLayoutEffect, useRef } from "react";
import { cn } from "../cn";

type TipState = {
  y: number;
  width: number;
  opacity: number;
  vy: number;
  vw: number;
  vo: number;
  ty: number;
  tw: number;
  to: number;
};

const PAD_X = 28; // left 14 + right ~14
const TIP_H = 36;
const TIP_W = 220;

function spring(value: number, velocity: number, target: number, dt: number, k = 280, d = 28) {
  const nextV = velocity + ((target - value) * k - velocity * d) * dt;
  const next = value + nextV * dt;
  if (Math.abs(next - target) < 0.05 && Math.abs(nextV) < 0.05) return [target, 0] as const;
  return [next, nextV] as const;
}

/**
 * LeiBox 流体提示气泡：挂在纵向图标导航内，悬停/聚焦时黑色胶囊滑到对应项并展开标签。
 * 省略演示画布、固定六入口与 GSAP 包体；业务侧用 data-fluid-tip 标记触发点。
 */
export function FluidRailTooltip({ className }: { className?: string }) {
  const tipRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const track = trackRef.current;
    const surface = surfaceRef.current;
    const viewport = viewportRef.current;
    const root = tip?.parentElement;
    if (!tip || !track || !surface || !viewport || !root) return;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const state: TipState = {
      y: 0,
      width: 120,
      opacity: 0,
      vy: 0,
      vw: 0,
      vo: 0,
      ty: 0,
      tw: 120,
      to: 0,
    };
    let frame = 0;
    let last = 0;
    let hint = -1;
    let hideTimer = 0;
    let dirty = true;
    let items: HTMLElement[] = [];
    let labels: Array<{ y: number; width: number; label: string }> = [];

    const paint = () => {
      const width = Math.max(48, Math.min(TIP_W, state.width));
      // 固定布局尺寸，只移动合成层；避免继承变量让所有标签逐帧重算样式。
      tip.style.transform = `translate3d(0,${state.y.toFixed(2)}px,0)`;
      tip.style.opacity = state.opacity.toFixed(3);
      surface.style.transform = `scaleX(${width / TIP_W})`;
      viewport.style.clipPath = `inset(0 ${TIP_W - width}px 0 0)`;
      track.style.transform = `translate3d(0,${-state.y.toFixed(2)}px,0)`;
      tip.setAttribute("aria-hidden", state.opacity < 0.05 ? "true" : "false");
    };

    const measureLabels = () => {
      if (!dirty) return;
      dirty = false;
      items = Array.from(root.querySelectorAll<HTMLElement>("[data-fluid-tip]")).filter(
        (node) => node.offsetParent !== null,
      );
      const rootBox = root.getBoundingClientRect();
      // 先批量读取位置，再批量写入，避免每个标签都强制刷新布局。
      labels = items.map((item) => {
        const box = item.getBoundingClientRect();
        return {
          y: box.top - rootBox.top + root.scrollTop + (box.height - TIP_H) / 2,
          width: 0,
          label: item.dataset.fluidTip || item.getAttribute("aria-label") || "",
        };
      });
      const rows = labels.map(({ y, label }, index) => {
        const row = document.createElement("div");
        row.className = "ft-tip-row";
        row.dataset.index = String(index);
        row.textContent = label;
        row.style.transform = `translateY(${y.toFixed(2)}px)`;
        return row;
      });
      track.replaceChildren(...rows);
      rows.forEach((row, index) => {
        labels[index]!.width = Math.min(TIP_W, Math.max(72, row.scrollWidth + PAD_X));
      });
    };

    const wake = () => {
      if (!frame && !media.matches && !document.hidden) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };

    const tick = (now: number) => {
      frame = 0;
      if (media.matches || document.hidden) {
        state.y = state.ty;
        state.width = state.tw;
        state.opacity = state.to;
        state.vy = state.vw = state.vo = 0;
        paint();
        return;
      }
      const dt = Math.min(0.032, (now - (last || now - 16)) / 1000);
      last = now;
      [state.y, state.vy] = spring(state.y, state.vy, state.ty, dt, 320, 30);
      [state.width, state.vw] = spring(state.width, state.vw, state.tw, dt, 260, 28);
      [state.opacity, state.vo] = spring(state.opacity, state.vo, state.to, dt, 240, 26);
      paint();
      const moving =
        Math.abs(state.y - state.ty) +
          Math.abs(state.width - state.tw) +
          Math.abs(state.opacity - state.to) +
          Math.abs(state.vy) +
          Math.abs(state.vw) +
          Math.abs(state.vo) >
        0.08;
      if (moving) frame = requestAnimationFrame(tick);
      else last = 0;
    };

    const show = (index: number, immediate = false) => {
      window.clearTimeout(hideTimer);
      if (!dirty && hint === index && state.to === 1 && !immediate) return;
      measureLabels();
      const next = labels[index];
      if (!next) return;
      hint = index;
      tip.setAttribute("aria-label", next.label);
      const first = state.opacity < 0.02;
      state.ty = next.y;
      state.tw = next.width;
      state.to = 1;
      if (immediate || media.matches) {
        state.y = next.y;
        state.width = next.width;
        state.opacity = 1;
        state.vy = state.vw = state.vo = 0;
        paint();
        return;
      }
      if (first) {
        state.y = next.y;
        state.width = next.width;
        state.vy = state.vw = 0;
        paint();
      }
      wake();
    };

    const hide = (immediate = false) => {
      window.clearTimeout(hideTimer);
      hint = -1;
      tip.removeAttribute("aria-label");
      state.to = 0;
      if (immediate || media.matches) {
        state.opacity = 0;
        state.vo = 0;
        paint();
        return;
      }
      wake();
    };

    const indexOf = (target: EventTarget | null) => {
      const node = (target as Element | null)?.closest?.("[data-fluid-tip]") as HTMLElement | null;
      if (!node || !root.contains(node)) return -1;
      measureLabels();
      return items.indexOf(node);
    };

    const onOver = (event: Event) => {
      const index = indexOf(event.target);
      if (index >= 0) show(index);
    };
    const onLeave = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        const focused = indexOf(root.ownerDocument.activeElement);
        if (focused >= 0) show(focused);
        else hide();
      }, 75);
    };
    const onFocusIn = (event: Event) => {
      const index = indexOf(event.target);
      if (index >= 0) show(index);
    };
    const onFocusOut = () => onLeave();

    root.addEventListener("pointerover", onOver);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);

    const invalidate = () => {
      dirty = true;
      if (hint >= 0) show(hint, true);
    };
    const ro = new ResizeObserver(invalidate);
    ro.observe(root);

    const mo = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => !tip.contains(mutation.target))) invalidate();
    });
    document.fonts.addEventListener("loadingdone", invalidate);
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-fluid-tip"],
    });

    paint();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(hideTimer);
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      ro.disconnect();
      mo.disconnect();
      document.fonts.removeEventListener("loadingdone", invalidate);
    };
  }, []);

  return (
    <div
      ref={tipRef}
      className={cn("ft-tip", className)}
      data-leibox="fluid-tooltip"
      aria-hidden="true"
    >
      <div ref={surfaceRef} className="ft-tip-surface" />
      <div ref={viewportRef} className="ft-tip-viewport">
        <div ref={trackRef} className="ft-tip-track" />
      </div>
    </div>
  );
}
