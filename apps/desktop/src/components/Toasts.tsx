import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@agentdesk/ui";
import { dismissToast, getToasts, subscribeToasts, type ToastTone } from "../lib/toast";

const TONE: Record<ToastTone, { icon: typeof CheckCircle2; border: string; iconClass: string }> = {
  success: {
    icon: CheckCircle2,
    border: "border-success/40",
    iconClass: "text-success",
  },
  danger: {
    icon: XCircle,
    border: "border-danger/40",
    iconClass: "text-danger",
  },
  warning: {
    icon: TriangleAlert,
    border: "border-warning/40",
    iconClass: "text-warning",
  },
  info: {
    icon: Info,
    border: "border-border",
    iconClass: "text-muted",
  },
};

/** 全局页面内 Toast，固定在右下角（审批卡片上方）。 */
export function Toasts() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (!items.length) return null;
  return (
    <div className="pointer-events-none fixed top-5 right-5 z-50 flex w-[360px] flex-col gap-2">
      {items.map((t) => {
        const tone = TONE[t.tone];
        const Icon = tone.icon;
        return (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-2xl border bg-elevated p-3.5 shadow-2xl animate-fade-in",
              tone.border,
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone.iconClass)} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold">{t.title}</p>
              {t.description ? (
                <p className="mt-0.5 truncate text-[12px] text-muted">{t.description}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="rounded-lg p-0.5 text-subtle hover:bg-surface-2 hover:text-fg"
              onClick={() => dismissToast(t.id)}
              aria-label="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
