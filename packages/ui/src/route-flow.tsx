import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "./cn";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

const NS = "http://www.w3.org/2000/svg";

/** 右侧的一个被路由到的目标（例如一个能力插件）。 */
export interface RouteFlowTarget {
  id: string;
  label: string;
  /** 次要标识，用等宽字体显示在标签后面。 */
  meta?: string;
  /** 本轮不参与：虚线边框 + 内容半透明。 */
  dormant?: boolean;
}

/** 一次路由：Supervisor 把请求发给某个目标，拿到结果再回来。 */
export interface RouteFlowStep {
  targetId: string;
  /** 中枢节点下方药丸上的文案。 */
  chip: string;
  /** 目标行上方浮出的标签。 */
  tag?: string;
  /** 底部解说文案。 */
  caption: string;
  /** 该目标行右侧的状态文字，完成后保留。 */
  result?: string;
  /** 这一步会失败并降级到 fallbackId。 */
  fail?: boolean;
  fallbackId?: string;
  fallbackTag?: string;
}

export interface RouteFlowProps {
  source: { label: string; sub?: string; icon?: ReactNode };
  hub: { label: string; sub?: string; icon?: ReactNode };
  targets: RouteFlowTarget[];
  steps: RouteFlowStep[];
  /** 跑完一轮后停留多久再重播，毫秒。 */
  loopDelay?: number;
  className?: string;
}

interface Trip {
  dot: SVGCircleElement | null;
  path: SVGPathElement | null;
  reverse: boolean;
  start: number;
  dur: number;
  resolve: () => void;
}

/**
 * 路由流程图：左侧来源 → 中枢 → 右侧多个目标。
 *
 * 连线不是静态图形，而是按真实 DOM 盒子测量后生成的三次贝塞尔路径（两个控制点的 x
 * 都取起止点的水平中点），布局变化时由 ResizeObserver 重算；数据包用 rAF 逐帧沿
 * path.getPointAtLength() 定位，所以窄屏换行后连线依然贴合。
 */
export function RouteFlow({
  source,
  hub,
  targets,
  steps,
  loopDelay = 4200,
  className,
}: RouteFlowProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const srcRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const wireRefs = useRef(new Map<string, SVGPathElement>());
  const srcWireRef = useRef<SVGPathElement>(null);
  const wireLengths = useRef(new WeakMap<SVGPathElement, number>());
  const still = usePrefersReducedMotion();

  const [chip, setChip] = useState("待命");
  const [caption, setCaption] = useState("—");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const staticResults: Record<string, string> = {};
  if (still) {
    for (const step of steps) {
      staticResults[step.targetId] = step.fail ? (step.tag ?? "失败") : (step.result ?? "完成");
      if (step.fail && step.fallbackId)
        staticResults[step.fallbackId] = step.fallbackTag ?? "已兜底";
    }
  }

  // 测量并重算所有连线的几何。
  useEffect(() => {
    const stage = stageRef.current;
    const svg = svgRef.current;
    if (!stage || !svg) return;

    const layout = () => {
      wireLengths.current = new WeakMap();
      const r = stage.getBoundingClientRect();
      if (!r.width) return;
      const box = (el: Element) => {
        const b = el.getBoundingClientRect();
        return {
          l: b.left - r.left,
          r: b.right - r.left,
          t: b.top - r.top,
          b: b.bottom - r.top,
          cx: (b.left + b.right) / 2 - r.left,
          cy: (b.top + b.bottom) / 2 - r.top,
        };
      };
      svg.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
      if (!srcRef.current || !hubRef.current) return;
      const s = box(srcRef.current);
      const h = box(hubRef.current);
      srcWireRef.current?.setAttribute(
        "d",
        h.l > s.r ? `M${s.r} ${s.cy} L${h.l} ${h.cy}` : `M${s.cx} ${s.b} L${h.cx} ${h.t}`,
      );
      for (const t of targets) {
        const row = rowRefs.current.get(t.id);
        const wire = wireRefs.current.get(t.id);
        if (!row || !wire) continue;
        const b = box(row);
        if (b.l > h.r) {
          const mx = (h.r + b.l) / 2;
          wire.setAttribute("d", `M${h.r} ${h.cy} C${mx} ${h.cy} ${mx} ${b.cy} ${b.l} ${b.cy}`);
        } else {
          // 窄屏：目标列表落到中枢下方，连线走列表左侧的竖直通道。
          const x = b.l - 14;
          wire.setAttribute(
            "d",
            `M${h.cx} ${h.b} C${h.cx} ${h.b + 26} ${x} ${h.b + 2} ${x} ${h.b + 28} L${x} ${
              b.cy - 10
            } Q${x} ${b.cy} ${b.l} ${b.cy}`,
          );
        }
      }
    };

    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [targets]);

  // 动画主循环。per-frame 的坐标写入直接操作 DOM，React state 只在步骤边界更新。
  useEffect(() => {
    const svg = svgRef.current;
    const stage = stageRef.current;
    if (!svg || !stage || steps.length === 0 || still) return;

    let trips: Trip[] = [];
    let clock = 0;
    let prev = 0;
    let visible = false;
    let raf = 0;
    let cancelled = false;

    const travel = (
      dot: SVGCircleElement | null,
      path: SVGPathElement | null,
      reverse: boolean,
      dur: number,
    ) =>
      new Promise<void>((resolve) => {
        trips.push({ dot, path, reverse, start: clock, dur, resolve });
      });
    const pause = (ms: number) => travel(null, null, false, ms);

    const packet = (back?: boolean) => {
      const c = document.createElementNS(NS, "circle") as SVGCircleElement;
      c.setAttribute("class", `rf-packet${back ? " is-back" : ""}`);
      c.setAttribute("r", back ? "4" : "4.5");
      c.setAttribute("cx", "-99");
      c.setAttribute("cy", "-99");
      svg.appendChild(c);
      return c;
    };

    const step = () => {
      const now = trips;
      trips = [];
      for (const tr of now) {
        const k = tr.dur ? Math.min(1, (clock - tr.start) / tr.dur) : 1;
        if (tr.dot && tr.path) {
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // easeInOutQuad
          let len = wireLengths.current.get(tr.path);
          if (len === undefined) {
            len = tr.path.getTotalLength();
            wireLengths.current.set(tr.path, len);
          }
          if (len) {
            const pt = tr.path.getPointAtLength((tr.reverse ? 1 - e : e) * len);
            tr.dot.setAttribute("cx", String(pt.x));
            tr.dot.setAttribute("cy", String(pt.y));
          }
        }
        if (k >= 1) {
          tr.dot?.remove();
          tr.resolve();
        } else trips.push(tr);
      }
    };

    const bump = (el: Element | null) => {
      if (!el) return;
      el.classList.remove("animate-node-tick");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("animate-node-tick");
    };

    const run = async () => {
      while (!cancelled) {
        setResults({});
        for (const s of steps) {
          if (cancelled) return;
          const wire = wireRefs.current.get(s.targetId) ?? null;
          const row = rowRefs.current.get(s.targetId) ?? null;
          setChip(s.chip);
          bump(srcRef.current);
          await travel(packet(), srcWireRef.current, false, 380);
          if (cancelled) return;
          bump(hubRef.current);
          setActiveId(s.targetId);
          await travel(packet(), wire, false, 420);
          if (cancelled) return;
          setCaption(s.caption);

          if (s.fail) {
            if (row) {
              row.classList.remove("animate-row-shake");
              void row.offsetWidth;
              row.classList.add("animate-row-shake");
            }
            setResults((r) => ({ ...r, [s.targetId]: s.tag ?? "失败" }));
            await travel(packet(true), wire, true, 300);
            if (cancelled) return;
            const fb = s.fallbackId ? (wireRefs.current.get(s.fallbackId) ?? null) : null;
            setChip("兜底");
            if (s.fallbackId) setActiveId(s.fallbackId);
            await travel(packet(), fb, false, 420);
            if (cancelled) return;
            if (s.fallbackId)
              setResults((r) => ({ ...r, [s.fallbackId!]: s.fallbackTag ?? "已兜底" }));
            await travel(packet(true), fb, true, 360);
            if (cancelled) return;
          } else {
            setResults((r) => ({ ...r, [s.targetId]: s.result ?? "完成" }));
            await pause(260);
            if (cancelled) return;
            await travel(packet(true), wire, true, 360);
            if (cancelled) return;
          }

          await travel(packet(true), srcWireRef.current, true, 320);
          if (cancelled) return;
          setActiveId(null);
          await pause(420);
          if (cancelled) return;
        }
        setChip("本轮完成");
        await pause(loopDelay);
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (cancelled || !visible || document.hidden) return;
      const dt = Math.min(now - (prev || now), 50);
      prev = now;
      clock += dt;
      step();
      raf = requestAnimationFrame(frame);
    };

    const syncVisibility = () => {
      if (visible && !document.hidden && !cancelled) {
        if (!raf) raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(raf);
        raf = 0;
        prev = 0;
      }
    };
    const io = new IntersectionObserver((es) => {
      visible = es[0]?.isIntersecting ?? false;
      syncVisibility();
    });
    io.observe(stage);
    document.addEventListener("visibilitychange", syncVisibility);
    void run();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", syncVisibility);
      for (const trip of trips) trip.resolve();
      trips = [];
      svg.querySelectorAll(".rf-packet").forEach((p) => p.remove());
    };
  }, [steps, loopDelay, still]);

  return (
    <div className={cn("rounded-2xl border bg-surface p-5", className)}>
      <div
        ref={stageRef}
        className="relative grid items-center gap-x-[72px] gap-y-7 py-6 [grid-template-columns:1fr_1fr] lg:[grid-template-columns:132px_148px_minmax(0,1fr)]"
      >
        <svg
          ref={svgRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        >
          <path ref={srcWireRef} className="rf-wire" />
          {targets.map((t) => (
            <path
              key={t.id}
              className="rf-wire"
              ref={(el) => {
                if (el) wireRefs.current.set(t.id, el);
                else wireRefs.current.delete(t.id);
              }}
            />
          ))}
        </svg>

        <Node innerRef={srcRef} {...source} />
        <Node innerRef={hubRef} {...hub} accent chip={still && steps.length ? "本轮完成" : chip} />

        <ol className="relative z-[1] col-span-2 grid gap-1.5 pl-6 lg:col-span-1 lg:pl-0">
          {targets.map((t) => {
            const active = !still && activeId === t.id;
            const result = (still ? staticResults : results)[t.id];
            return (
              <li
                key={t.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(t.id, el);
                  else rowRefs.current.delete(t.id);
                }}
                className={cn(
                  "relative grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl border bg-surface px-3.5 py-2.5 text-[13.5px] transition-colors",
                  active && "border-brand",
                  t.dormant && "border-dashed",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full border-[1.5px] border-subtle",
                    active && "rf-dot-live border-brand bg-brand",
                    t.dormant && "opacity-45",
                  )}
                />
                <span className={cn("truncate font-medium", t.dormant && "opacity-45")}>
                  {t.label}
                  {t.meta ? (
                    <span className="ml-2 font-mono text-[12px] font-normal text-subtle">
                      {t.meta}
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    "whitespace-nowrap tabular-nums text-[12px] text-subtle",
                    active && "text-fg",
                    t.dormant && "opacity-45",
                  )}
                >
                  {t.dormant ? "休眠" : (result ?? "待命")}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <p
        aria-live="polite"
        className="flex min-h-[3em] items-center border-t pt-3.5 text-[14px] text-fg"
      >
        {still ? (steps.at(-1)?.caption ?? "—") : caption}
      </p>
    </div>
  );
}

function Node({
  innerRef,
  label,
  sub,
  icon,
  accent,
  chip,
}: {
  innerRef: RefObject<HTMLDivElement | null>;
  label: string;
  sub?: string;
  icon?: ReactNode;
  accent?: boolean;
  chip?: string;
}) {
  return (
    <div
      ref={innerRef}
      className={cn(
        "relative z-[1] flex flex-col items-center gap-0.5 rounded-2xl border bg-surface px-2.5 py-4 text-center",
        accent && "border-brand shadow-[0_0_0_4px_var(--ad-surface-2)]",
      )}
    >
      {icon ? <div className={cn("mb-1", accent ? "text-brand" : "text-fg")}>{icon}</div> : null}
      <b className="text-[13.5px] font-semibold">{label}</b>
      {sub ? <small className="text-[11.5px] text-subtle">{sub}</small> : null}
      {chip ? (
        <span className="mt-1.5 whitespace-nowrap rounded-full bg-brand px-2.5 py-0.5 text-[11.5px] font-medium text-white">
          {chip}
        </span>
      ) : null}
    </div>
  );
}
