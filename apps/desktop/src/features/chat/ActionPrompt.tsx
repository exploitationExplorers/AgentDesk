import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleHelp } from "lucide-react";
import type { Approval } from "@agentdesk/shared";
import { Button } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { chatActionDisplay } from "../../lib/approval-display";

/** 对话只承载用户决策，执行参数保留在编码现场。 */
export function ActionPrompt({ approval }: { approval: Approval }) {
  const client = useQueryClient();
  const display = chatActionDisplay(approval);
  const action = useMutation({
    mutationFn: (approved: boolean) => api.resolveApproval(approval.id, approved),
    onSuccess: () => {
      client.setQueryData<Approval[]>(["approvals", "pending"], (pending) =>
        pending?.filter((item) => item.id !== approval.id),
      );
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["approvals"] });
      void client.invalidateQueries({ queryKey: ["session-workbench"] });
    },
  });
  return (
    <section aria-label="确认下一步" className="rounded-2xl border bg-surface p-5 shadow-sm">
      <div className="flex items-start gap-2">
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0">
          <h2 className="break-words text-[14px] font-medium leading-6">{display.title}</h2>
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-muted">
            {display.detail}
          </p>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" disabled={action.isPending} onClick={() => action.mutate(false)}>
          暂不执行
        </Button>
        <Button
          disabled={action.isPending}
          loading={action.isPending}
          onClick={() => action.mutate(true)}
        >
          继续执行
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
      {action.error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          操作未完成，请重试。
        </p>
      ) : null}
    </section>
  );
}
