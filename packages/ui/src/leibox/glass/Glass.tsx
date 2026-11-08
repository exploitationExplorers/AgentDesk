/* Canvas UI / David Haz, distributed by LeiBox. See LICENSE and ../NOTICE. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createGlass, type GlassOptions } from "./GlassVanilla";
import { cn } from "../../cn";

/** 保持可操作 DOM 始终挂载；上游 DOM capture 支持无实验 API 的浏览器。 */
export function Glass({
  children,
  className,
  ...options
}: { children: ReactNode; className?: string } & GlassOptions) {
  const content = useRef<HTMLDivElement>(null);
  const output = useRef<HTMLCanvasElement>(null);
  const [initial] = useState(options);
  const [mode, setMode] = useState("static");
  useEffect(() => {
    const element = content.current;
    const canvas = output.current;
    if (!element || !canvas) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)");
    let instance: ReturnType<typeof createGlass> = null;
    const update = () => {
      instance?.destroy();
      instance = null;
      if (!media.matches) {
        const source = document.createElement("canvas");
        instance = createGlass(
          { source, content: element, output: canvas, capture: "snapshot" },
          initial,
        );
      }
      setMode(instance ? "webgl" : "static");
    };
    update();
    media.addEventListener("change", update);
    return () => {
      instance?.destroy();
      media.removeEventListener("change", update);
    };
  }, [initial]);
  return (
    <div className={cn("lb-glass-lens", className)} data-leibox="glass" data-renderer={mode}>
      <div ref={content} className="lb-glass-lens-content">
        {children}
      </div>
      <canvas
        ref={output}
        aria-hidden="true"
        className="lb-glass-lens-output"
        hidden={mode === "static"}
      />
    </div>
  );
}
