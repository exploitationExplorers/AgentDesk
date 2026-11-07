import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "./cn";
import { AnimatePresence, motion, panelVariants, useReducedMotion } from "./motion";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
}

/** 单选菜单：键盘焦点与视觉选中状态分开，避免方向键直接修改业务状态。 */
export function ChoiceMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: T;
  options: ChoiceOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const reduced = useReducedMotion();
  const selected = options.find((option) => option.value === value);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open) buttons.current[focused]?.focus();
  }, [focused, open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const show = () => {
    setFocused(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };
  return (
    <div
      ref={root}
      className="relative min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          }
        }}
        className={cn(
          "flex h-9 min-w-0 items-center gap-2 rounded-xl px-2.5 text-xs font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50",
          className,
        )}
      >
        {selected?.icon}
        <span className="truncate">{selected?.label}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 text-subtle transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={id}
            role="listbox"
            aria-label={label}
            variants={reduced ? undefined : panelVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="absolute bottom-[calc(100%+12px)] left-0 z-40 w-64 max-w-[calc(100vw-48px)] origin-bottom-left rounded-2xl border bg-elevated p-1.5 shadow-xl"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                setFocused((index) =>
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? options.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
                        options.length,
                );
              }
            }}
          >
            <p className="px-3 py-2 text-[11px] font-medium text-subtle">{label}</p>
            {options.map((option, index) => (
              <button
                key={option.value}
                ref={(element) => {
                  buttons.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={index === focused ? 0 : -1}
                onFocus={() => setFocused(index)}
                onClick={() => {
                  onChange(option.value);
                  close(true);
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2",
                  option.value === value && "bg-brand/8",
                )}
              >
                <span className="text-brand">{option.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {option.value === value ? <Check className="h-3.5 w-3.5 text-brand" /> : null}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
