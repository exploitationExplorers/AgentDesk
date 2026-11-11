import type { MotionOptions, MotionController } from "./motion-runtime";
export type ElasticPanelResizeOptions = MotionOptions;
export function mountElasticPanelResize(
  target: HTMLElement,
  options?: ElasticPanelResizeOptions,
): MotionController;
