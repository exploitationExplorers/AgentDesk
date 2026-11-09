import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { memo, useEffect, useId, useRef } from "react";
import type { FlowEdgeData } from "./flow-layout";

type FluidEdgeType = Edge<FlowEdgeData, "fluid">;

/**
 * 参考成长页 RouteFlow：沿贝塞尔路径用 rAF + getPointAtLength 推进数据包，
 * live 边循环流动，静止边播完一次后停在终点附近淡出。
 */
export const FluidEdge = memo(function FluidEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps<FluidEdgeType>) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const pathRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const live = Boolean(data?.live);
  const gradId = useId().replace(/:/g, "");

  useEffect(() => {
    const path = pathRef.current;
    const dot = dotRef.current;
    if (!path || !dot) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      const len = path.getTotalLength();
      if (len) {
        const pt = path.getPointAtLength(len * 0.5);
        dot.setAttribute("cx", String(pt.x));
        dot.setAttribute("cy", String(pt.y));
        dot.setAttribute("opacity", live ? "0.85" : "0");
      }
      return;
    }

    let raf = 0;
    let start = 0;
    let visible = true;
    const duration = live ? 1400 : 900;

    const frame = (now: number) => {
      if (!start) start = now;
      if (!visible || document.hidden) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const len = path.getTotalLength();
      if (!len) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const elapsed = now - start;
      const t = live ? (elapsed % duration) / duration : Math.min(1, elapsed / duration);
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const pt = path.getPointAtLength(ease * len);
      dot.setAttribute("cx", String(pt.x));
      dot.setAttribute("cy", String(pt.y));
      if (live) {
        dot.setAttribute("opacity", "1");
      } else {
        // 播完一次后淡出，避免终态图上满屏飞点
        const fade = t >= 1 ? Math.max(0, 1 - (elapsed - duration) / 400) : 1;
        dot.setAttribute("opacity", String(fade));
        if (fade <= 0) return;
      }
      raf = requestAnimationFrame(frame);
    };

    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    });
    io.observe(path);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [edgePath, live]);

  return (
    <>
      <defs>
        <linearGradient id={`flow-grad-${gradId}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="var(--ad-border)" />
          <stop offset="100%" stopColor={live ? "var(--ad-brand)" : "var(--ad-border-strong)"} />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: `url(#flow-grad-${gradId})`,
          strokeDasharray: live ? "4 6" : undefined,
        }}
        className={live ? "code-flow-wire-live" : undefined}
      />
      {/* 测量用的隐形 path：BaseEdge 不暴露 DOM path 引用 */}
      <path ref={pathRef} d={edgePath} fill="none" stroke="transparent" strokeWidth={1} />
      <circle
        ref={dotRef}
        r={live ? 4.5 : 3.5}
        className={live ? "code-flow-packet is-live" : "code-flow-packet"}
        cx={sourceX}
        cy={sourceY}
        opacity={0}
      />
    </>
  );
});
