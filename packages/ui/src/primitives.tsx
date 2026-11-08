import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import {
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "./cn";
import { GlassSurface } from "./leibox/glass-surface";
import { GlassTabMenu } from "./leibox/glass-tab-menu";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <GlassSurface className={cn("ad-card rounded-2xl", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-4", className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-[14px] font-semibold tracking-tight", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 pb-4 pt-3", className)} {...props} />;
}

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
  {
    variants: {
      tone: {
        neutral: "bg-surface-2 text-muted border border-border",
        brand: "bg-brand/15 text-brand",
        success: "bg-success/15 text-success",
        warning: "bg-warning/15 text-warning",
        danger: "bg-danger/15 text-danger",
        info: "bg-info/15 text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const fieldBase =
  "lb-field w-full rounded-xl border px-3 text-[13px] text-fg placeholder:text-subtle outline-none transition-colors focus:border-border-strong focus:ring-2 focus:ring-brand/30 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(fieldBase, "h-9", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldBase, "min-h-20 py-2 leading-6", className)} {...props} />
));
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(fieldBase, "h-9 appearance-auto pr-2", className)} {...props} />
  ),
);
Select.displayName = "Select";

export function Label({
  className,
  ...props
}: HTMLAttributes<HTMLLabelElement> & { htmlFor?: string }) {
  return (
    <label
      className={cn("mb-1.5 block text-[12px] font-medium text-muted", className)}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="mt-1 text-[11.5px] text-subtle">{hint}</p> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-muted", className)} />;
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "rounded-md border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted",
        className,
      )}
      {...props}
    />
  );
}

export function StatusDot({
  status,
  className,
}: {
  status: "idle" | "running" | "success" | "warning" | "error";
  className?: string;
}) {
  const color = {
    idle: "bg-subtle",
    running: "bg-info animate-pulse-soft",
    success: "bg-success",
    warning: "bg-warning",
    error: "bg-danger",
  }[status];
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", color, className)} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center",
        className,
      )}
    >
      {icon ? <div className="text-subtle">{icon}</div> : null}
      <div>
        <p className="text-[14px] font-medium">{title}</p>
        {description ? (
          <p className="mt-1 max-w-md text-[12.5px] text-muted">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="ad-page-header flex flex-wrap items-start justify-between gap-5 pb-7">
      <div className="flex min-w-0 flex-1 basis-[280px] items-start gap-3.5">
        {icon ? (
          <GlassSurface className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-brand">
            {icon}
          </GlassSurface>
        ) : null}
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight sm:text-[27px]">
            {title}
          </h1>
          {description ? (
            <p className="mt-2 max-w-2xl text-[12.5px] leading-6 text-muted">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <GlassTabMenu
      value={value}
      options={options}
      onChange={onChange}
      className={className}
      label={label}
    />
  );
}
