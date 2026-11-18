import test from "node:test";
import assert from "node:assert/strict";
import { cubicPoint, flightControls, flightEase, flightGeometry } from "../dist/index.js";
const a = { x: 20, y: 40 },
  b = { x: 640, y: 420 };
test("each stable route starts and ends at its exact semantic anchors", () => {
  const variants = [0.1, 0.35, 0.6, 0.85].map((seed) => [a, ...flightControls(a, b, seed), b]);
  assert.equal(new Set(variants.map(JSON.stringify)).size, 4);
  for (const points of variants) {
    assert.deepEqual(cubicPoint(points, 0), a);
    assert.deepEqual(cubicPoint(points, 1), b);
    assert.deepEqual(flightControls(a, b, 0.6), variants[2].slice(1, 3));
  }
});
test("slow ends, faster middle, monotone travel", () => {
  const values = Array.from({ length: 101 }, (_, i) => flightEase(i / 100));
  assert.equal(values[0], 0);
  assert.equal(values.at(-1), 1);
  assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]));
  assert.ok(values[50] - values[49] > 20 * (values[1] - values[0]));
});
test("visible head follows the curve, with a finite trail including coincident anchors", () => {
  for (const end of [a, b]) {
    const points = [a, ...flightControls(a, end, 0.6), end];
    for (const progress of [0, 0.1, 0.5, 0.9, 1]) {
      const g = flightGeometry({ points, progress, color: "#2686c8" });
      assert.deepEqual(g.b, cubicPoint(points, flightEase(progress)));
      assert.ok(g.dash.split(" ").every((v) => Number.isFinite(Number(v)) && Number(v) >= 0));
      assert.equal(g.stops[1]["stop-color"], "#2686c8");
    }
  }
});
