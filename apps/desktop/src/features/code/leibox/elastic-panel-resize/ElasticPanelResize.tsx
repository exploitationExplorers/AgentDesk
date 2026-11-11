"use client";
import { useEffect, useRef } from "react";
import {
  mountElasticPanelResize,
  type ElasticPanelResizeOptions,
} from "./ElasticPanelResizeEngine.js";
import type { MotionController } from "./motion-runtime";

export function ElasticPanelResize({
  options,
  className,
}: {
  options?: ElasticPanelResizeOptions;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<MotionController | null>(null);
  useEffect(() => {
    const instance = mountElasticPanelResize(host.current!, options);
    controller.current = instance;
    return () => {
      instance.destroy();
      controller.current = null;
    };
    // Options are updated below without remounting the state machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    controller.current?.update(options ?? {});
  }, [options]);
  return <div ref={host} className={className} data-motion-component="elastic-panel-resize" />;
}
