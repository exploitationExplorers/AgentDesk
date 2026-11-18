export interface Point {
  readonly x: number;
  readonly y: number;
}
export type Cubic = readonly [Point, Point, Point, Point];
export interface CurveRoute {
  readonly id: string;
  readonly eventId: string;
  readonly source: string;
  readonly target: string;
  readonly kind: "selection" | "reference" | "retry" | "flight";
  readonly points: Cubic;
  readonly color: string;
  readonly opacity: number;
  readonly dashed?: boolean;
  readonly progress?: number;
}
export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const segment = (value: number, start: number, end: number) =>
  clamp((value - start) / (end - start));
export const smoothstep = (value: number) => value * value * (3 - 2 * value);
export function cubicEase(x1: number, y1: number, x2: number, y2: number) {
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let a = 0,
      b = 1,
      u = t;
    for (let i = 0; i < 22; i++) {
      u = (a + b) / 2;
      const x = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u ** 2 * x2 + u ** 3;
      if (x < t) a = u;
      else b = u;
    }
    return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u ** 2 * y2 + u ** 3;
  };
}
export const FLIGHT_SECONDS = 1.2;
export const LANDING_SECONDS = 0.6;
export const flightEase = smoothstep;
export const outEase = cubicEase(0.16, 1, 0.3, 1);
export const springEase = cubicEase(0.3, 1.5, 0.5, 1);
export function bezier(a: Point, c1: Point, c2: Point, b: Point, p: number): Point {
  const q = 1 - p;
  return {
    x: q * q * q * a.x + 3 * q * q * p * c1.x + 3 * q * p * p * c2.x + p * p * p * b.x,
    y: q * q * q * a.y + 3 * q * q * p * c1.y + 3 * q * p * p * c2.y + p * p * p * b.y,
  };
}
export const cubicPoint = (points: Cubic, t: number) => bezier(...points, t);
export const cubicPath = ([a, c, d, b]: Cubic) =>
  `M ${a.x} ${a.y} C ${c.x} ${c.y} ${d.x} ${d.y} ${b.x} ${b.y}`;

/** One emission seed chooses a stable arc; never randomize while advancing frames. */
export function flightControls(a: Point, b: Point, seed: number): readonly [Point, Point] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const variant = Math.min(3, Math.floor(seed * 4));
  const variation = (seed * 4) % 1;
  const amplitude = Math.min(180, length * (0.14 + variation * 0.12));
  const direction = variant % 2 === 0 ? -1 : 1;
  const control = (fraction: number, bend: number): Point => ({
    x: Math.max(8, a.x + dx * fraction - (dy / length) * bend),
    y: Math.max(8, a.y + dy * fraction + (dx / length) * bend),
  });
  return [
    control(0.25 + variation * 0.1, direction * amplitude),
    control(0.65 + variation * 0.1, direction * amplitude * (variant < 2 ? 0.8 : -0.8)),
  ];
}

function arcLength(route: CurveRoute, end: number): number {
  let length = 0,
    previous = route.points[0];
  for (let i = 1; i <= 64; i++) {
    const next = cubicPoint(route.points, (end * i) / 64);
    length += Math.hypot(next.x - previous.x, next.y - previous.y);
    previous = next;
  }
  return length;
}
export function flightGeometry(route: CurveRoute) {
  const progress = route.progress ?? 0;
  const head = flightEase(progress);
  const tail = flightEase(segment(progress, 0.75, 1)) * 0.35;
  const a = cubicPoint(route.points, tail),
    b = cubicPoint(route.points, head);
  const start = arcLength(route, tail),
    end = arcLength(route, head),
    total = arcLength(route, 1);
  return {
    d: cubicPath(route.points),
    head,
    a,
    b,
    start,
    dash: `${Math.max(0, end - start)} ${total + 1}`,
    stops: [
      { offset: 0, "stop-color": route.color, "stop-opacity": 0 },
      { offset: 1, "stop-color": route.color },
    ] as Record<string, string | number>[],
  };
}
