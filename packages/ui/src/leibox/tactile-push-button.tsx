import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";

/** LeiBox / 少荃：保留 button-outer、button-inner 的按压表面结构。 */
export function TactileSurface({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="button-outer" aria-hidden="true">
        <span className="button-inner" />
      </span>
      <span className="lb-button-content">{children}</span>
    </>
  );
}

export const TactilePushButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(({ children, className, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    data-leibox="tactile-push-button"
    className={cn("lb-button", className)}
    {...props}
  >
    <TactileSurface>{children}</TactileSurface>
  </button>
));
TactilePushButton.displayName = "TactilePushButton";
