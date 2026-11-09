import { Link, useRouterState } from "@tanstack/react-router";
import { Badge, cn } from "@agentdesk/ui";

const TABS = [
  { to: "/learning", label: "今日学习" },
  { to: "/learning/review", label: "复习" },
  { to: "/learning/library", label: "资料库" },
  { to: "/learning/interview", label: "面试题" },
  { to: "/learning/career", label: "能力地图" },
] as const;

/**
 * 成长中心内部页面之间切换。
 * 放在每页 PageHeader 的 actions 里，避免用户进了子页就找不到回去的路。
 */
export function LearningNav({ dueCount }: { dueCount?: number }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      aria-label="成长导航"
      className="inline-flex flex-wrap rounded-xl border bg-surface-2 p-0.5"
    >
      {TABS.map((t) => {
        // "/learning" 要精确匹配，否则子路由下它也会被判定为选中。
        const active = t.to === "/learning" ? pathname === "/learning" : pathname === t.to;
        return (
          <Link
            key={t.to}
            to={t.to}
            className={cn(
              "flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 text-[12px] font-medium transition-colors",
              active ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.to === "/learning/review" && dueCount ? (
              <Badge tone="brand" className="px-1.5 py-0 tabular-nums">
                {dueCount}
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
