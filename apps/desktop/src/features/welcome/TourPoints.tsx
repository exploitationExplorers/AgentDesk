import { Pause, Play } from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TourKind } from "./showcase-scenes";

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

export function TourPoints({
  kind,
  points,
  active,
}: {
  kind: TourKind;
  points: readonly { title: string; description: string }[];
  active: boolean;
}) {
  const [selected, setSelected] = useState(0);
  const [paused, setPaused] = useState(false);
  const visible = useSyncExternalStore(subscribeVisibility, () => !document.hidden);
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stage = host.current?.closest(".tour-stage");
    const attribute = `data-demo-${kind}`;
    stage?.setAttribute(attribute, String(selected));
    return () => stage?.removeAttribute(attribute);
  }, [kind, selected]);

  return (
    <div className="tour-points" ref={host} role="group" aria-label="场景演示">
      <div className="tour-points-head">
        <span>场景演示</span>
        <button
          type="button"
          aria-label={paused ? "继续自动演示" : "暂停自动演示"}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
        </button>
      </div>
      {points.map((point, i) => {
        const current = i === selected;
        const id = `tour-point-${kind}-${i}`;
        return (
          <div className="tour-point" key={point.title}>
            <button
              type="button"
              aria-expanded={current}
              aria-controls={id}
              onClick={() => {
                setSelected(i);
                setPaused(true);
              }}
            >
              <span aria-hidden="true" className="tour-point-number">
                0{i + 1}
              </span>
              {point.title}
            </button>
            <p id={id} hidden={!current}>
              {point.description}
            </p>
            {current && (
              <div className="tour-point-track" aria-hidden="true">
                <span
                  className="tour-point-meter"
                  data-running={active && visible && !paused ? "" : undefined}
                  onAnimationEnd={() => {
                    if (active && visible && !paused) setSelected((i + 1) % points.length);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
