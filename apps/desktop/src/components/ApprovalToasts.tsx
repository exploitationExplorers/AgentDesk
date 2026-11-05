import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { AnimatePresence, Badge, Button, motion, popVariants } from "@agentdesk/ui";
import { api } from "../lib/api";
import { chatActionDisplay } from "../lib/approval-display";

const RISK_LABEL = { safe: "安全", confirm: "需确认", dangerous: "高风险" } as const;
const KIND_LABEL = {
  workflow: "工作流",
  tool: "工具",
  deploy: "部署",
  question: "追问",
  plan: "方案",
  review: "验收",
} as const;

/** 待审批固定在右下角：任意页面可见（不代表你刚点了执行）。 */
export function ApprovalToasts() {
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
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
  const dismissAll = useMutation({
    mutationFn: async () => {
      await Promise.all(
        data.filter((a) => a.kind !== "question").map((a) => api.resolveApproval(a.id, false)),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const pending = data.filter((approval) => approval.kind !== "question");
  if (pending.length === 0 || pathname === "/" || pathname === "/code") return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-40 flex w-[380px] flex-col gap-2">
      {pending.length > 1 ? (
        <div className="pointer-events-auto flex items-center justify-between rounded-xl border border-warning/30 bg-elevated/95 px-3 py-2 text-[12px] text-muted shadow-lg">
          <span>{pending.length} 个待审批</span>
          <Button
            size="sm"
            variant="ghost"
            loading={dismissAll.isPending}
            onClick={() => dismissAll.mutate()}
          >
            全部忽略
          </Button>
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {pending.slice(0, 1).map((a) => (
          <motion.div
            key={a.id}
            layout
            variants={popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="pointer-events-auto rounded-2xl border border-warning/40 bg-elevated p-4 shadow-2xl"
          >
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-[13px] font-semibold">{chatActionDisplay(a).title}</p>
                  <Badge tone="neutral">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                  <Badge tone={a.risk === "dangerous" ? "danger" : "warning"}>
                    {RISK_LABEL[a.risk]}
                  </Badge>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted">{chatActionDisplay(a).detail}</p>
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
          </motion.div>
        ))}
      </AnimatePresence>
      {pending.length > 1 ? (
        <p className="pointer-events-auto text-right text-[12px] text-muted">
          还有 {pending.length - 1} 个待审批
        </p>
      ) : null}
    </div>
  );
}
