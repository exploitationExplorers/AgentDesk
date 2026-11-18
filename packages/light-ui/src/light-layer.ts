import {
  FLIGHT_SECONDS,
  LANDING_SECONDS,
  flightControls,
  outEase,
  type CurveRoute,
  type Point,
} from "./geometry.js";
import { renderRoute, svgElement, updateFlight } from "./svg.js";

/** Points use viewport coordinates, just like Element.getBoundingClientRect(). */
export type Anchor = Element | Point | (() => Element | Point | null);
export interface Flight {
  readonly id: string;
  readonly source: Anchor;
  readonly target: Anchor;
  readonly color: string;
  readonly duration?: number;
  /** Stable in [0, 1); changes the route once per emission, never per frame. */
  readonly seed?: number;
  readonly sourceKind?: "model" | "message";
}
export type FlightResult = "arrived" | "cancelled" | "missing-anchor";
export interface LightLayer {
  emit(flight: Flight): { finished: Promise<FlightResult>; cancel(): void };
  pause(): void;
  resume(): void;
  destroy(): void;
  readonly activeCount: number;
  readonly paused: boolean;
}
interface Job {
  flight: Flight;
  elapsed: number;
  duration: number;
  seed: number;
  group?: SVGGElement;
  ring?: SVGCircleElement;
  resolved: boolean;
  resolve(result: FlightResult): void;
}
let layerSerial = 0;

/** One overlay, one active-only rAF loop. No React, timers, global styles or network. */
export function createLightLayer(root: HTMLElement = document.body): LightLayer {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("Light UI needs a mounted browser document.");
  const svg = svgElement("svg", { "aria-hidden": "true", "data-light-layer": "" });
  Object.assign(svg.style, {
    position: root === doc.body ? "fixed" : "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "10",
  });
  root.append(svg);
  const prefix = `light-${++layerSerial}`;
  const jobs = new Map<string, Job>();
  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;
  let lastTick: number | undefined;
  let paused = false;
  let destroyed = false;
  let serial = 0;
  const resolve = (job: Job, result: FlightResult) => {
    if (job.resolved) return;
    job.resolved = true;
    job.resolve(result);
  };
  const remove = (id: string, result: FlightResult) => {
    const job = jobs.get(id);
    if (!job) return;
    resolve(job, result);
    job.group?.remove();
    job.ring?.remove();
    jobs.delete(id);
    if (!jobs.size) {
      win.cancelAnimationFrame(frame);
      frame = 0;
      lastTick = undefined;
    }
  };
  const point = (anchor: Anchor, rect: DOMRect): Point | null => {
    const value = typeof anchor === "function" ? anchor() : anchor;
    if (!value) return null;
    let p: Point;
    if ("getBoundingClientRect" in value) {
      if (!value.isConnected) return null;
      const bounds = value.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;
      p = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    } else p = value;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return { x: p.x - rect.x, y: p.y - rect.y };
  };
  const draw = (now: number) => {
    frame = 0;
    if (destroyed || paused || doc.hidden) return;
    const delta = lastTick === undefined ? 0 : Math.max(0, now - lastTick);
    lastTick = now;
    const rect = svg.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    // Batch geometry reads before SVG writes to avoid read/write layout thrashing.
    const anchors = new Map<Job, readonly [Point | null, Point | null]>();
    for (const job of jobs.values())
      anchors.set(job, [point(job.flight.source, rect), point(job.flight.target, rect)]);
    for (const [id, job] of jobs) {
      const [a, b] = anchors.get(job)!;
      if (!a || !b) {
        remove(id, "missing-anchor");
        continue;
      }
      if (reduced.matches) {
        remove(id, "arrived");
        continue;
      }
      job.elapsed += delta;
      if (job.elapsed < job.duration) {
        const route: CurveRoute = {
          id,
          eventId: id,
          source: job.flight.sourceKind === "model" ? `family:${id}` : `chat:${id}`,
          target: `tree:${id}`,
          kind: "flight",
          color: job.flight.color,
          opacity: 1,
          progress: job.elapsed / job.duration,
          points: [a, ...flightControls(a, b, job.seed), b],
        };
        if (job.group) updateFlight(job.group, route);
        else {
          job.group = renderRoute(route, `${prefix}-${++serial}`);
          svg.append(job.group);
        }
      } else {
        job.group?.remove();
        job.group = undefined;
        resolve(job, "arrived");
        const age = (job.elapsed - job.duration) / (LANDING_SECONDS * 1000);
        if (age >= 1) {
          remove(id, "arrived");
          continue;
        }
        const progress = outEase(age);
        if (!job.ring) {
          job.ring = svgElement("circle", {
            fill: "none",
            stroke: job.flight.color,
            "stroke-width": 1.2,
            "data-flight-landing": id,
          });
          svg.append(job.ring);
        }
        for (const [key, value] of Object.entries({
          cx: b.x,
          cy: b.y,
          r: 5 + progress * 20,
          opacity: (1 - progress) * 0.5,
        }))
          job.ring.setAttribute(key, String(value));
      }
    }
    schedule();
  };
  const schedule = () => {
    if (frame || !jobs.size || paused || doc.hidden || destroyed) return;
    frame = win.requestAnimationFrame(draw);
  };
  const suspend = () => {
    win.cancelAnimationFrame(frame);
    frame = 0;
    lastTick = undefined;
  };
  const visibility = () => {
    suspend();
    schedule();
  };
  doc.addEventListener("visibilitychange", visibility);
  reduced.addEventListener("change", schedule);
  return {
    emit(flight) {
      if (destroyed) throw new Error("This light layer has been destroyed.");
      if (!flight.id || jobs.has(flight.id)) throw new Error("Use a unique event ID per flight.");
      if (jobs.size >= 128)
        throw new Error("Too many simultaneous flights; batch business events.");
      const duration = flight.duration ?? FLIGHT_SECONDS * 1000;
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Duration must be positive.");
      const seed = flight.seed ?? Math.random();
      if (!Number.isFinite(seed) || seed < 0 || seed >= 1)
        throw new Error("Seed must be in [0, 1).");
      const finished = new Promise<FlightResult>((resolve) => {
        jobs.set(flight.id, { flight, duration, seed, elapsed: 0, resolved: false, resolve });
      });
      schedule();
      return { finished, cancel: () => remove(flight.id, "cancelled") };
    },
    pause() {
      paused = true;
      suspend();
    },
    resume() {
      paused = false;
      schedule();
    },
    destroy() {
      destroyed = true;
      suspend();
      for (const id of jobs.keys()) remove(id, "cancelled");
      doc.removeEventListener("visibilitychange", visibility);
      reduced.removeEventListener("change", schedule);
      svg.remove();
    },
    get activeCount() {
      return jobs.size;
    },
    get paused() {
      return paused;
    },
  };
}
