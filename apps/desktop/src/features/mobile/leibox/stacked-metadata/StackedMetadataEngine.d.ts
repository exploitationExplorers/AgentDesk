import type { MotionOptions, MotionController } from "./motion-runtime";
export type StackedMetadataOptions = MotionOptions & {
  heading?: string;
  items?: { title: string; priority: string; date: string; assignee: string; team?: boolean }[];
  theme?: "light" | "dark";
  expanded?: number;
  onExpandChange?: (index: number) => void;
};
export function mountStackedMetadata(
  target: HTMLElement,
  options?: StackedMetadataOptions,
): Omit<MotionController, "update"> & { update(options: StackedMetadataOptions): void };
