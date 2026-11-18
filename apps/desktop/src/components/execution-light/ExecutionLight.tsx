import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { createLightLayer, type LightLayer } from "@agentdesk/light-ui";
import "@agentdesk/light-ui/running-border.css";

export interface LightEvent {
  id: string;
  from: string;
  to: string;
  color: string;
}
/** 新业务事件到达才发射；历史加载、暂停和缺少锚点均不制造执行活动。 */
export function useExecutionLights(
  host: RefObject<HTMLDivElement | null>,
  events: LightEvent[],
  paused = false,
) {
  const layer = useRef<LightLayer | null>(null);
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  useEffect(() => {
    if (!host.current) return;
    layer.current = createLightLayer(host.current);
    return () => {
      layer.current?.destroy();
      layer.current = null;
    };
  }, [host]);
  useEffect(() => {
    const target = host.current;
    const sync = () => {
      target?.classList.toggle("light-motion-paused", paused || document.hidden);
      if (paused || document.hidden) layer.current?.pause();
      else layer.current?.resume();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      target?.classList.remove("light-motion-paused");
    };
  }, [host, paused]);
  useEffect(() => {
    const target = host.current,
      light = layer.current;
    if (!target || !light) return;
    const fresh = events.filter((event) => !seen.current.has(event.id));
    const ready = primed.current;
    for (const event of fresh) seen.current.add(event.id);
    if (events.length) primed.current = true;
    if (seen.current.size > 2048) seen.current = new Set(events.map((event) => event.id));
    if (!ready || paused || document.hidden) return;
    for (const event of fresh.slice(-12)) {
      if (light.activeCount >= 48) break;
      const source = target.querySelector<HTMLElement>(
        `[data-light-anchor="${CSS.escape(event.from)}"]`,
      );
      const destination = target.querySelector<HTMLElement>(
        `[data-light-anchor="${CSS.escape(event.to)}"]`,
      );
      if (!source || !destination) continue;
      light.emit({ id: event.id, source, target: destination, color: event.color, duration: 1100 });
    }
  }, [events, host, paused]);
}

export function RunningLightBorder({
  active,
  color = "#818cf8",
}: {
  active: boolean;
  color?: string;
}) {
  if (!active) return null;
  return (
    <svg
      className="light-running-border"
      style={{ "--light-color": color } as CSSProperties}
      aria-hidden="true"
    >
      <rect
        x="1"
        y="1"
        width="calc(100% - 2px)"
        height="calc(100% - 2px)"
        rx="12"
        pathLength="100"
      />
    </svg>
  );
}
