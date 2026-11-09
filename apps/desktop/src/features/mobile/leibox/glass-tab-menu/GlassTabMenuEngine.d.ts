import type { MotionOptions, MotionController } from "./motion-runtime";
export type GlassTabMenuOptions = MotionOptions;
export function mountGlassTabMenu(
  target: HTMLElement,
  options?: GlassTabMenuOptions,
): MotionController;
