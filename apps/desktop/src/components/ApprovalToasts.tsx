import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { Badge, Button } from "@agentdesk/ui";
import { api } from "../lib/api";

const RISK_LABEL = { safe: "安全", confirm: "需确认", dangerous: "高风险" } as const;

/** 待审批的 ActionDraft 固定在右下角，任何页面都能处理。 */
export function ApprovalToasts() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals("pending"),
    refetchInterval: 15_000,
  });
  const resolve = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) =>
      api.resolveApproval(id, approved),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });

  if (data.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-40 flex w-[380px] flex-col gap-2">
      {data.slice(0, 3).map((a) => (
        <div
          key={a.id}
          className="pointer-events-auto rounded-2xl border border-warning/40 bg-elevated p-4 shadow-2xl animate-fade-in"
        >
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-[13px] font-semibold">{a.title}</p>
                <Badge tone={a.risk === "dangerous" ? "danger" : "warning"}>
                  {RISK_LABEL[a.risk]}
                </Badge>
              </div>
              {a.detail ? (
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono text-[11.5px] text-muted">
                  {a.detail}
                </pre>
              ) : null}
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => resolve.mutate({ id: a.id, approved: false })}
                >
                  拒绝
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => resolve.mutate({ id: a.id, approved: true })}
                >
                  批准执行
                </Button>
              </div>
            </div>
          </div>
        </div>
      ))}
      {data.length > 3 ? (
        <p className="pointer-events-auto text-right text-[12px] text-muted">
          还有 {data.length - 3} 个待审批
        </p>
      ) : null}
    </div>
  );
}
