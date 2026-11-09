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

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const track = trackRef.current;
    const root = tip?.parentElement;
    if (!tip || !track || !root) return;

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

    const triggers = () =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-fluid-tip]")).filter(
        (node) => node.offsetParent !== null,
      );

    const paint = () => {
      tip.style.setProperty("--ft-y", `${state.y.toFixed(2)}px`);
      tip.style.setProperty("--ft-w", `${Math.max(48, state.width).toFixed(2)}px`);
      tip.style.setProperty("--ft-o", state.opacity.toFixed(3));
      tip.setAttribute("aria-hidden", state.opacity < 0.05 ? "true" : "false");
    };

    const rebuildLabels = (items: HTMLElement[]) => {
      track.replaceChildren();
      const rootBox = root.getBoundingClientRect();
      items.forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "ft-tip-row";
        row.dataset.index = String(index);
        row.textContent = item.dataset.fluidTip || item.getAttribute("aria-label") || "";
        const box = item.getBoundingClientRect();
        const center = box.top - rootBox.top + root.scrollTop + box.height / 2;
        row.style.transform = `translateY(${(center - TIP_H / 2).toFixed(2)}px)`;
        track.append(row);
      });
    };

    const measure = (index: number) => {
      const items = triggers();
      const item = items[index];
      if (!item) return null;
      rebuildLabels(items);
      const rootBox = root.getBoundingClientRect();
      const box = item.getBoundingClientRect();
      const center = box.top - rootBox.top + root.scrollTop + box.height / 2;
      const label = item.dataset.fluidTip || item.getAttribute("aria-label") || "";
      const probe = track.querySelector<HTMLElement>(`[data-index="${index}"]`);
      const textW = probe?.scrollWidth ?? Math.ceil(label.length * 13);
      return {
        y: center - TIP_H / 2,
        width: Math.min(220, Math.max(72, textW + PAD_X)),
        label,
      };
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
      const next = measure(index);
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
      return triggers().indexOf(node);
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

    const ro = new ResizeObserver(() => {
      if (hint >= 0) show(hint, true);
    });
    ro.observe(root);

    const mo = new MutationObserver((mutations) => {
      if (hint >= 0 && mutations.some((mutation) => !tip.contains(mutation.target))) {
        show(hint, true);
      }
    });
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
    };
  }, []);

  return (
    <div
      ref={tipRef}
      className={cn("ft-tip", className)}
      data-leibox="fluid-tooltip"
      aria-hidden="true"
    >
      <div ref={trackRef} className="ft-tip-track" />
    </div>
  );
}
