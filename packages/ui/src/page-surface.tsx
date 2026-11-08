import type { ReactNode } from "react";
import { cn } from "./cn";
import { MotionConfig } from "./motion";

/** 列表与管理页面共用的阅读宽度、表面层级和动效偏好。 */
export function PageSurface({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <MotionConfig reducedMotion="user">
      <div className="ad-page h-full min-w-0 overflow-y-auto">
        <div
          className={cn(
            "ad-page-content mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-8 lg:px-10 lg:pt-12 lg:pb-10",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </MotionConfig>
  );
}

export function PageMetrics({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; detail?: string }>;
}) {
  return (
    <dl className="ad-page-metrics mb-7 grid grid-cols-3 overflow-hidden rounded-2xl border bg-surface">
      {items.map((item) => (
        <div
          key={item.label}
          className="min-w-0 border-r px-4 py-4 last:border-r-0 sm:px-6 sm:py-5"
        >
          <dt className="text-[11px] text-muted sm:text-xs">{item.label}</dt>
          <dd className="mt-2 text-[25px] font-semibold leading-none tracking-tight tabular-nums sm:text-[30px]">
            {item.value}
          </dd>
          {item.detail ? (
            <p className="mt-2 text-[11px] leading-5 text-subtle">{item.detail}</p>
          ) : null}
        </div>
      ))}
    </dl>
  );
}
