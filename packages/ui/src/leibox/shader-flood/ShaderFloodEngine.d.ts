import type { MotionOptions, MotionController } from "./motion-runtime";
export type ShaderFloodOptions = MotionOptions & {
  items?: {
    title: string;
    description: string;
    icon?: "rocket" | "zap" | "palette" | "globe" | "aperture" | "clapperboard" | "layers";
    colors?: [string, string, string];
  }[];
  seed?: number;
  speed?: number;
  theme?: "light" | "dark";
  background?: string;
};
export function mountShaderFlood(
  target: HTMLElement,
  options?: ShaderFloodOptions,
): Omit<MotionController, "update"> & { update(options: ShaderFloodOptions): void };
