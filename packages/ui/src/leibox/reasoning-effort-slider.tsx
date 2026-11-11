import { useId, useMemo, type KeyboardEvent } from "react";
import { cn } from "../cn";

/** LeiBox reasoning-effort-slider 的三档语义；对外映射到 Codex/pi-ai 的 low/medium/high。 */
export type ThinkingDepth = "simple" | "medium" | "deep";

export const THINKING_DEPTH_OPTIONS: Array<{
  value: ThinkingDepth;
  label: string;
  hint: string;
}> = [
  { value: "simple", label: "轻量", hint: "快答、小改动" },
  { value: "medium", label: "标准", hint: "日常任务" },
  { value: "deep", label: "深入", hint: "复杂排查" },
];

export const THINKING_DEPTH_TO_EFFORT = {
  simple: "low",
  medium: "medium",
  deep: "high",
} as const;

export function effortToThinkingDepth(
  effort: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined,
): ThinkingDepth {
  if (effort === "minimal" || effort === "low") return "simple";
  if (effort === "high" || effort === "xhigh") return "deep";
  return "medium";
}

/**
 * Composer 旁的精简思考强度滑块（LeiBox reasoning-effort-slider 语义）。
 * 完整演示版默认高 420px，这里只保留三档吸附与填充动效，适合工具栏 popover。
 */
export function ReasoningEffortSlider({
  value,
  onValueChange,
  disabled,
  className,
}: {
  value: ThinkingDepth;
  onValueChange: (value: ThinkingDepth) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const index = Math.max(
    0,
    THINKING_DEPTH_OPTIONS.findIndex((option) => option.value === value),
  );
  const fill = useMemo(() => (index / (THINKING_DEPTH_OPTIONS.length - 1)) * 100, [index]);

  const move = (next: number) => {
    if (disabled) return;
    const option =
      THINKING_DEPTH_OPTIONS[Math.max(0, Math.min(THINKING_DEPTH_OPTIONS.length - 1, next))];
    if (option) onValueChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      move(index + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      move(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(THINKING_DEPTH_OPTIONS.length - 1);
    }
  };

  return (
    <div
      data-leibox="reasoning-effort-slider"
      className={cn("lb-effort", disabled && "pointer-events-none opacity-50", className)}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p id={`${id}-label`} className="text-[11px] font-medium text-muted">
          思考强度
        </p>
        <p className="text-[11px] text-fg">{THINKING_DEPTH_OPTIONS[index]?.label}</p>
      </div>
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-valuemin={0}
        aria-valuemax={THINKING_DEPTH_OPTIONS.length - 1}
        aria-valuenow={index}
        aria-valuetext={THINKING_DEPTH_OPTIONS[index]?.label}
        aria-disabled={disabled || undefined}
        className="lb-effort-track outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        onKeyDown={onKeyDown}
      >
        <span className="lb-effort-fill" style={{ width: `${fill}%` }} aria-hidden="true" />
        <span className="lb-effort-thumb" style={{ left: `${fill}%` }} aria-hidden="true" />
        <div className="lb-effort-stops">
          {THINKING_DEPTH_OPTIONS.map((option, offset) => (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-label={`${option.label}：${option.hint}`}
              className={cn("lb-effort-stop", offset === index && "is-active")}
              onClick={() => onValueChange(option.value)}
            />
          ))}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-muted">
        {THINKING_DEPTH_OPTIONS.map((option, offset) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            className={cn(
              "rounded-md px-1 py-0.5 text-center transition-colors",
              offset === index ? "bg-brand/12 text-brand" : "hover:text-fg",
            )}
            onClick={() => onValueChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
