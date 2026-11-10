import type { MotionOptions, MotionController } from "./motion-runtime";
export type AiImageGenerationOptions = MotionOptions;
export function mountAiImageGeneration(
  target: HTMLElement,
  options?: AiImageGenerationOptions,
): MotionController;
