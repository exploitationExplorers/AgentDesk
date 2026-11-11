import { useEffect, useState, type CSSProperties, type RefObject } from "react";

export interface CollaborationWire {
  id: string;
  from: string;
  to: string;
  color: string;
  live: boolean;
}

const cnWire = (live: boolean) => (live ? "ad-collab-wire is-live" : "ad-collab-wire");

export function CollaborationWires({
  host,
  wires,
}: {
  host: RefObject<HTMLDivElement | null>;
  wires: CollaborationWire[];
}) {
  const [geometry, setGeometry] = useState<{
    width: number;
    height: number;
    paths: Record<string, string>;
  }>({ width: 1, height: 1, paths: {} });
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      const box = container.getBoundingClientRect();
      const paths: Record<string, string> = {};
      for (const wire of wires) {
        const source = container.querySelector(`[data-collab-port="${CSS.escape(wire.from)}"]`);
        const target = container.querySelector(`[data-collab-port="${CSS.escape(wire.to)}"]`);
        if (!source || !target) continue;
        const a = source.getBoundingClientRect(),
          b = target.getBoundingClientRect();
        const x1 = a.left + a.width / 2 - box.left,
          y1 = a.top + a.height / 2 - box.top;
        const x2 = b.left + b.width / 2 - box.left,
          y2 = b.top + b.height / 2 - box.top;
        const bend = Math.max(28, Math.abs(x2 - x1) * 0.55);
        paths[wire.id] = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
      }
      setGeometry({ width: Math.max(1, box.width), height: Math.max(1, box.height), paths });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    container
      .querySelectorAll<HTMLElement>("[data-collab-node]")
      .forEach((node) => observer.observe(node));
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [host, wires]);
  return (
    <svg
      className="ad-collab-wires"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      aria-hidden="true"
    >
      {wires.map((wire, index) => {
        const d = geometry.paths[wire.id];
        if (!d) return null;
        return (
          <g
            key={wire.id}
            style={
              {
                "--collab-color": wire.color,
                "--collab-delay": `${index * -0.55}s`,
              } as CSSProperties
            }
          >
            <path className={cnWire(wire.live)} d={d} />
            {wire.live ? (
              <>
                <path className="ad-collab-packet" d={d} pathLength={100} />
                <path className="ad-collab-packet ad-collab-packet-core" d={d} pathLength={100} />
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
