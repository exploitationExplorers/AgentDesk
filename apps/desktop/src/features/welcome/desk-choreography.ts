import { MathUtils, type Object3D } from "three";

// Lanes end on either side of the glass; coordinates are fractions of the phone tableau.
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

export function laneFor(name: string) {
  return names.findIndex((agent) => name === `bot-${agent}-body`);
}

export function runAcrossDesk(
  bot: Object3D,
  i: number,
  travel: number,
  t: number,
  width: number,
  height: number,
) {
  const {
    home: [x, y, z],
    end: [u, v],
  } = lanes[i]!;
  // Stagger departures. The route depends on scroll position, so reversing never teleports a runner.
  const f = MathUtils.smoothstep(travel, (i % 3) * 0.045, 0.84 + (i % 4) * 0.045);
  const arc = Math.sin(Math.PI * f);
  const phase = t * (0.9 + i * 0.045) + i * 1.83;
  const stride = t * 4.5 + f * 60 + i;
  const roam = 0.35 + 1.05 * f;
  const px = MathUtils.lerp(x, mobileDeskX + (u - 0.5) * width, f);
  const pz = MathUtils.lerp(z, -2 + (v - 0.5) * height, f) + arc * (i % 2 ? 8 : -6);
  // Step off the palm rest onto the paper rather than floating at keyboard height.
  const edge = Math.max(Math.abs(px) - 15.5, Math.abs(pz) - 11);
  const elevation = MathUtils.lerp(y, 0.04, MathUtils.smoothstep(edge, -0.5, 1));
  bot.position.set(
    px + roam * Math.cos(phase),
    elevation + Math.abs(Math.sin(stride)) * (0.28 + arc * 0.46),
    pz + roam * Math.sin(phase),
  );
  // Tip faces toward the overhead camera as the runners reach the handset.
  bot.rotation.x = -0.48 * f;
  bot.rotation.y = 0.18 + arc * 1.0 + Math.sin(phase) * (0.22 + f * 0.5);
  bot.rotation.z = Math.cos(stride) * (0.055 + arc * 0.09);
}
