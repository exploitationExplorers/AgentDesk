"use client";
import { useEffect, useRef } from "react";
import { mountPixelToggle, type PixelToggleOptions } from "./PixelToggleEngine.js";
import type { MotionController } from "./motion-runtime";

export function PixelToggle({
  options,
  className,
}: {
  options?: PixelToggleOptions;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<MotionController | null>(null);
  const initialOptions = useRef(options);
  useEffect(() => {
    const instance = mountPixelToggle(host.current!, initialOptions.current);
    controller.current = instance;
    return () => {
      instance.destroy();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    controller.current?.update(options ?? {});
  }, [options]);
  return <div ref={host} className={className} data-motion-component="pixel-toggle" />;
}
