import { MathUtils, Vector3, type Object3D } from "three";
import { phoneIndex } from "./showcase-scenes";

const lanes = [
  { home: [4.8, 1.72, -4.7], end: [0.81, 0.18] },
  { home: [-4.9, 1.72, -4], end: [0.28, 0.22] },
  { home: [-11.8, 1.56, 9], end: [0.38, 0.84] },
  { home: [-8.1, 1.56, 9.5], end: [0.82, 0.91] },
  { home: [-4.5, 1.56, 9.4], end: [0.23, 0.54] },
  { home: [2.4, 1.56, 9.6], end: [0.36, 0.08] },
  { home: [8.7, 1.56, 9.2], end: [0.82, 0.46] },
] as const;
const names = ["claude", "codex", "qwen", "pi", "antigravity", "deepseek", "copilot"];
export const mobileDeskX = 54;
const rimHeight = 22.4;
const rimDepth = -17.1;
const lerp = MathUtils.lerp;
const clamp = MathUtils.clamp;
const smooth = MathUtils.smoothstep;
const tap = (cycle: number) => Math.abs(Math.sin(cycle));
const sample = new Vector3();
const tangent = new Vector3();

export function laneFor(name: string) {
  return names.findIndex((agent) => name === `bot-${agent}-body`);
}

function aroundPhone(out: Vector3, f: number, i: number, width: number, height: number) {
  const [u, v] = lanes[i]!.end;
  const rimX = (i - 3) * 4.35;
  const landingX = 9.5 + i * 0.77;
  const landingZ = -7.8 + (i % 3) * 2.8;
  const floorX = 17.2 + (i % 3) * 2.3;
  const floorZ = -6 + (i % 2) * 8 + i * 0.47;
  if (f < 0.19) {
    const p = smooth(f, 0, 0.19);
    out.set(
      lerp(rimX, Math.min(rimX + 4.5, 14), p),
      rimHeight + 0.3 * tap(p * 3 * Math.PI),
      rimDepth,
    );
  } else if (f < 0.46) {
    const p = (f - 0.19) / 0.27;
    // Push forward over the glass, then drop onto the keyboard with a bent trajectory.
    out.set(
      lerp(Math.min(rimX + 4.5, 14), landingX, p),
      lerp(rimHeight, 1.62, p * p) + 2.8 * Math.sin(Math.PI * p),
      lerp(rimDepth, landingZ, 1 - (1 - p) ** 2),
    );
  } else if (f < 0.61) {
    const p = (f - 0.46) / 0.15;
    out.set(
      lerp(landingX, floorX, p),
      lerp(1.62, 0.03, smooth(p, 0.55, 1)) + 0.58 * tap(2 * Math.PI * p),
      lerp(landingZ, floorZ, p),
    );
  } else {
    const p = (f - 0.61) / 0.39;
    out.set(
      lerp(floorX, mobileDeskX + (u - 0.5) * width, p),
      0.03 + (0.45 + 0.27 * Math.sin(Math.PI * p)) * tap(7 * Math.PI * p),
      lerp(floorZ, -2 + (v - 0.5) * height, p) + (i % 2 ? 5 : -5) * Math.sin(Math.PI * p),
    );
  }
}

function returnToMac(out: Vector3, f: number, i: number, width: number, height: number) {
  const {
    home: [x, y, z],
    end: [u, v],
  } = lanes[i]!;
  const edgeZ = 7 + (i % 3) * 1.5;
  if (f < 0.75) {
    const p = f / 0.75;
    out.set(
      lerp(mobileDeskX + (u - 0.5) * width, 16, p),
      0.03 + 0.7 * tap(6 * Math.PI * p),
      lerp(-2 + (v - 0.5) * height, edgeZ, p) + 6 * Math.sin(Math.PI * p),
    );
  } else {
    const p = (f - 0.75) / 0.25;
    out.set(
      lerp(16, x * 0.61 - 4.4, p),
      lerp(0.03, y, Math.min(1, 4 * p)) + 0.8 * tap(3 * Math.PI * p),
      lerp(edgeZ, z * 0.48 + 1.6, p),
    );
  }
}

export function runAcrossDesk(
  bot: Object3D,
  i: number,
  progress: number,
  t: number,
  width: number,
  height: number,
  scrollDirection: number,
) {
  const [x, y, z] = lanes[i]!.home;
  const chapter = Math.floor(progress);
  const fraction = progress - chapter;
  const phase = t * 2.75 + i * 1.83;
  const stride = t * 8 + progress * 50 + i;
  if (chapter < phoneIndex - 1) {
    const perch = smooth(fraction, 0.09 + (i % 3) * 0.035, 0.91 + (i % 3) * 0.022);
    bot.position.set(
      lerp(x, (i - 3) * 4.35, perch),
      lerp(y, rimHeight, 1 - (1 - perch) ** 2) + 0.32 * tap(phase) ** 5,
      lerp(z, rimDepth, perch * perch),
    );
    bot.rotation.set(0, 0.18 + 0.12 * Math.sin(phase), 0.045 * Math.cos(phase));
    return;
  }
  if (chapter === phoneIndex - 1 || chapter === phoneIndex) {
    const arriving = chapter === phoneIndex - 1;
    const delay = (6 - i) * 0.019;
    const f = clamp((fraction - 0.07 - delay) / 0.8, 0, 1);
    const route = arriving ? aroundPhone : returnToMac;
    route(sample, f, i, width, height);
    const step = f < 0.995 ? 0.005 : -0.005;
    route(tangent, f + step, i, width, height);
    tangent.sub(sample).multiplyScalar(Math.sign(step) * scrollDirection);
    const moving = Math.sin(Math.PI * f);
    const heading = Math.atan2(tangent.x, tangent.z) * moving ** 0.65;
    const phonePose = arriving ? smooth(f, 0.75, 1) : 1 - smooth(f, 0, 0.25);
    bot.position.copy(sample);
    bot.position.y += (1 - moving) * 0.32 * tap(phase) ** 5;
    bot.rotation.set(
      -0.48 * phonePose,
      heading + 0.18 + 0.12 * Math.sin(phase),
      0.045 * Math.cos(phase) + moving * 0.13 * Math.cos(stride),
    );
    return;
  }

  const cross = smooth(fraction, 0.06 + (i % 3) * 0.06, 0.8 + (i % 3) * 0.06);
  const left = chapter % 2 === 0 ? cross : 1 - cross;
  const moving = Math.sin(Math.PI * cross);
  bot.position.set(
    lerp(x, x * 0.61 - 4.4, left),
    y + 0.32 * tap(phase) ** 5 + moving * 0.8 * tap(stride),
    lerp(z, z * 0.48 + 1.6, left) + (i % 2 ? 1 : -1) * 1.8 * moving,
  );
  bot.rotation.set(
    0,
    0.18 + (chapter % 2 ? 1 : -1) * moving * 1.24 * scrollDirection + 0.12 * Math.sin(phase),
    0.045 * Math.cos(phase) + moving * 0.13 * Math.cos(stride),
  );
}
