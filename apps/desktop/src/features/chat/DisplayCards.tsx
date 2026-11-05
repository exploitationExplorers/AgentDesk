import { CheckCircle2, Star, XCircle } from "lucide-react";
import type { AgentDeskCardData, EntityCardData, StatusTableCardData } from "@agentdesk/shared";
import { cn } from "@agentdesk/ui";

function EntityCard({ data }: { data: EntityCardData }) {
  const body = (
    <div className="flex gap-3 p-3">
      {data.imageUrl ? (
        <img
          src={data.imageUrl}
          alt=""
          className="h-16 w-16 shrink-0 rounded-lg object-cover bg-surface-2"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-fg">{data.title}</div>
        {data.subtitle ? (
          <div className="mt-0.5 truncate text-[12.5px] text-muted">{data.subtitle}</div>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
          {typeof data.rating === "number" ? (
            <span className="inline-flex items-center gap-1 text-fg">
              <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
              {data.rating.toFixed(1)}
            </span>
          ) : null}
          {data.price ? <span className="font-medium text-fg">{data.price}</span> : null}
          {data.meta ? <span>{data.meta}</span> : null}
        </div>
      </div>
    </div>
  );
  if (data.href) {
    return (
      <a
        href={data.href}
        target="_blank"
        rel="noreferrer"
        className="block overflow-hidden rounded-xl border bg-surface hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-brand"
      >
        {body}
      </a>
    );
  }
  return <div className="overflow-hidden rounded-xl border bg-surface">{body}</div>;
}

function StatusTableCard({ data }: { data: StatusTableCardData }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-surface">
      {data.title ? (
        <div className="border-b px-3 py-2 text-[13px] font-medium">{data.title}</div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-surface-2/50 text-left text-muted">
              {data.columns.map((col) => (
                <th key={col} className="px-3 py-2 font-medium">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i} className="border-t">
                {data.columns.map((_, colIndex) => {
                  const cell = row.cells[colIndex] ?? "";
                  const isStatusCol =
                    colIndex === data.columns.findIndex((c) => /状态|status/i.test(c));
                  if (isStatusCol && (row.status || row.statusLabel)) {
                    return (
                      <td key={colIndex} className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          {row.status === "ok" ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                          ) : row.status === "error" ? (
                            <XCircle className="h-3.5 w-3.5 text-danger" />
                          ) : null}
                          <span
                            className={cn(
                              row.status === "ok" && "text-success",
                              row.status === "error" && "text-danger",
                            )}
                          >
                            {row.statusLabel ?? cell}
                          </span>
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td key={colIndex} className="px-3 py-2">
                      {cell.split(/(`[^`]+`)/g).map((part, partIndex) =>
                        part.startsWith("`") && part.endsWith("`") ? (
                          <code
                            key={partIndex}
                            className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12px]"
                          >
                            {part.slice(1, -1)}
                          </code>
                        ) : (
                          <span key={partIndex}>{part}</span>
                        ),
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DisplayCard({ data }: { data: AgentDeskCardData }) {
  if (data.variant === "entity") return <EntityCard data={data} />;
  return <StatusTableCard data={data} />;
}
