import { cubicPath, flightGeometry, segment, type CurveRoute } from "./geometry.js";

const NS = "http://www.w3.org/2000/svg";
export function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}
export function renderRoute(route: CurveRoute, serial: string | number): SVGGElement {
  const group = svgElement("g", { opacity: route.opacity });
  const d = cubicPath(route.points);
  const attrs = { d, fill: "none", stroke: route.color, "stroke-linecap": "round" };
  const path = svgElement("path", {
    ...attrs,
    "stroke-width": route.kind === "selection" ? (route.opacity === 0.75 ? 2.4 : 1.3) : 1.2,
    "data-curve-route": "true",
    "data-curve-id": route.id,
    "data-curve-event": route.eventId,
    "data-source-key": route.source,
    "data-target-key": route.target,
    "data-curve-kind": route.kind,
  });
  if (route.kind === "flight" && route.progress !== undefined) {
    const { head, a, b, start, dash, stops } = flightGeometry(route);
    const gradientId = `process-flight-${serial}`;
    const gradient = svgElement("linearGradient", {
      id: gradientId,
      gradientUnits: "userSpaceOnUse",
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
    });
    gradient.append(...stops.map((stop) => svgElement("stop", stop)));
    group.append(gradient);
    for (const [width, opacity] of [
      [6, 0.07],
      [2.6, 0.13],
    ])
      group.append(
        svgElement("path", {
          ...attrs,
          "stroke-width": width!,
          opacity: opacity!,
          "stroke-dasharray": dash,
          "stroke-dashoffset": -start,
        }),
      );
    path.setAttribute("stroke", `url(#${gradientId})`);
    path.setAttribute("stroke-width", route.source.startsWith("family:") ? "2" : "1.3");
    path.setAttribute("stroke-dasharray", dash);
    path.setAttribute("stroke-dashoffset", String(-start));
    path.dataset.headProgress = String(head);
    if (route.source.startsWith("family:"))
      group.append(
        svgElement("circle", {
          cx: route.points[0].x,
          cy: route.points[0].y,
          r: 10,
          fill: "none",
          stroke: route.color,
          "stroke-width": 2,
          "data-flight-source": route.source,
        }),
      );
    group.append(
      path,
      svgElement("circle", { cx: b.x, cy: b.y, r: 6, fill: route.color, opacity: 0.16 }),
      svgElement("circle", {
        cx: b.x,
        cy: b.y,
        r: 2.2,
        fill: route.color,
        "data-flight-head": route.id,
      }),
    );
  } else {
    if (route.dashed) path.setAttribute("stroke-dasharray", route.kind === "retry" ? "2 2" : "4 4");
    group.append(path);
  }
  return group;
}

export function updateFlight(group: SVGGElement, route: CurveRoute) {
  const { d, head, a, b, start, dash } = flightGeometry(route);
  group.setAttribute("opacity", String(route.opacity));
  for (const path of group.querySelectorAll("path")) {
    if (path.getAttribute("d") !== d) path.setAttribute("d", d);
    path.setAttribute("stroke-dasharray", dash);
    path.setAttribute("stroke-dashoffset", String(-start));
    if (path.hasAttribute("data-curve-route")) path.dataset.headProgress = String(head);
  }
  const gradient = group.querySelector("linearGradient")!;
  for (const [key, value] of Object.entries({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
    gradient.setAttribute(key, String(value));
  for (const circle of group.querySelectorAll("circle")) {
    if (circle.hasAttribute("data-flight-source")) {
      const launch = segment(route.progress ?? 0, 0, 0.55);
      circle.setAttribute("cx", String(route.points[0].x));
      circle.setAttribute("cy", String(route.points[0].y));
      circle.setAttribute("r", String(10 + launch * 8));
      circle.setAttribute("opacity", String((1 - launch) * 0.8));
      continue;
    }
    circle.setAttribute("cx", String(b.x));
    circle.setAttribute("cy", String(b.y));
  }
}
