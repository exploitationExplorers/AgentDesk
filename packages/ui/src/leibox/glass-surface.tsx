import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../cn";

/** 从 LeiBox Glass Tab Menu 的 gt-panel 提取材质，支持原有语义元素。 */
export const GlassSurface = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    asChild?: boolean;
    elevated?: boolean;
  }
>(({ asChild, elevated, className, ...props }, ref) => {
  const Component = asChild ? Slot : "div";
  return (
    <Component
      ref={ref}
      data-leibox="glass-surface"
      className={cn("lb-glass", elevated && "lb-glass-elevated", className)}
      {...props}
    />
  );
});
GlassSurface.displayName = "GlassSurface";
