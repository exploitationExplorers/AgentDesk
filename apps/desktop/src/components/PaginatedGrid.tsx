import { Fragment, useRef, useState, type Key, type ReactNode } from "react";
import { Button, motion } from "@agentdesk/ui";

/** 只挂载当前页，避免大量卡片及其菜单、Tooltip 一起阻塞路由提交。筛选变化时由 key 重置。 */
export function PaginatedGrid<T>({
  items,
  itemKey,
  children,
  label,
  className,
}: {
  items: T[];
  itemKey: (item: T) => Key;
  children: (item: T) => ReactNode;
  label: string;
  className: string;
}) {
  const pageSize = 12;
  const [requestedPage, setPage] = useState(0);
  const root = useRef<HTMLElement>(null);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(requestedPage, pages - 1);
  const start = page * pageSize;
  const changePage = (next: number) => {
    setPage(next);
    root.current?.scrollIntoView({ block: "start", behavior: "instant" });
  };

  return (
    <section ref={root} aria-label={label} className="scroll-mt-6">
      <motion.div
        key={page}
        className={className}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12 }}
      >
        {items.slice(start, start + pageSize).map((item) => (
          <Fragment key={itemKey(item)}>{children(item)}</Fragment>
        ))}
      </motion.div>
      {pages > 1 ? (
        <nav aria-label={`${label}分页`} className="mt-5 flex flex-wrap items-center gap-3">
          <span className="mr-auto text-xs tabular-nums text-subtle" role="status">
            {start + 1}–{Math.min(start + pageSize, items.length)} / {items.length} 条
          </span>
          <Button size="sm" disabled={page === 0} onClick={() => changePage(page - 1)}>
            上一页
          </Button>
          <span className="text-xs tabular-nums text-muted">
            {page + 1} / {pages}
          </span>
          <Button size="sm" disabled={page === pages - 1} onClick={() => changePage(page + 1)}>
            下一页
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
