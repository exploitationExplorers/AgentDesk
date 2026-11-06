import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@agentdesk/ui";
import { api } from "../../lib/api";

export function AutomationRecovery({
  taskId,
  conversationId,
}: {
  taskId: string;
  conversationId: string;
}) {
  const client = useQueryClient();
  const resume = useMutation({
    mutationFn: () => api.resumeAutomationTask(taskId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["session-workbench", conversationId] });
      void client.invalidateQueries({ queryKey: ["automation-tasks"] });
      void client.invalidateQueries({ queryKey: ["interactions", taskId] });
    },
  });
  return (
    <div className="space-y-2">
      <Button size="sm" disabled={resume.isPending} onClick={() => resume.mutate()}>
        {resume.isPending ? "正在检查…" : "检查并恢复"}
      </Button>
      <p className="text-xs text-muted">确认可安全继续后恢复；执行结果不明确时会提示需要核实。</p>
      {resume.error ? (
        <p role="alert" className="text-xs text-danger">
          {resume.error.message}
        </p>
      ) : resume.isSuccess ? (
        <p role="status" className="text-xs text-muted">
          已完成恢复检查，正在更新任务状态。
        </p>
      ) : null}
    </div>
  );
}
