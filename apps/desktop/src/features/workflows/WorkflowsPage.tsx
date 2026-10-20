import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarClock, Hand, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, Dialog, EmptyState, PageHeader, Spinner } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/format";

const RUN_TONE = {
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
} as const;
const RUN_LABEL = {
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
} as const;

function TemplateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ["workflow-templates"], queryFn: api.workflowTemplates });
  const create = useMutation({
    mutationFn: api.createWorkflowFromTemplate,
    onSuccess: (wf) => void navigate({ to: "/workflows/$id", params: { id: wf.id } }),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="新建工作流"
      description="从模板开始，或者从空白画布搭建。"
    >
      <div className="grid gap-2">
        {templates.data?.map((t) => (
          <button
            key={t.key}
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate(t.key)}
            className="rounded-xl border bg-surface-2/40 px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
          >
            <p className="text-[13.5px] font-medium">{t.name}</p>
            <p className="mt-0.5 text-[12px] text-muted">{t.description}</p>
          </button>
        ))}
        {create.error ? <p className="text-[12.5px] text-danger">{create.error.message}</p> : null}
      </div>
    </Dialog>
  );
}

export function WorkflowsPage() {
  const queryClient = useQueryClient();
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows });
  const runs = useQuery({ queryKey: ["workflow-runs"], queryFn: () => api.workflowRuns() });
  const [creating, setCreating] = useState(false);
  const remove = useMutation({
    mutationFn: api.deleteWorkflow,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows"] }),
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          icon={<WorkflowIcon className="h-5 w-5" />}
          title="工作流"
          description="像扣子一样拖拽编排：大模型、Agent、工具、Git、宝塔部署、审批、通知，也可以让 Bot 帮你触发"
          actions={
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="h-3.5 w-3.5" />
              新建工作流
            </Button>
          }
        />
        {workflows.isLoading ? <Spinner /> : null}
        {workflows.data?.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {workflows.data.map((wf) => {
              const last = runs.data?.find((r) => r.workflowId === wf.id);
              return (
                <Card
                  key={wf.id}
                  className="group relative p-4 transition-colors hover:border-border-strong"
                >
                  <Link
                    to="/workflows/$id"
                    params={{ id: wf.id }}
                    className="absolute inset-0"
                    aria-label={wf.name}
                  />
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 truncate text-[14px] font-semibold">{wf.name}</p>
                    <button
                      type="button"
                      aria-label="删除"
                      className="relative z-10 hidden rounded p-1 text-subtle hover:text-danger group-hover:block"
                      onClick={() => remove.mutate(wf.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="mt-1 line-clamp-2 min-h-9 text-[12.5px] text-muted">
                    {wf.description || "暂无描述"}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {wf.trigger.type === "schedule" ? (
                      <Badge tone="brand">
                        <CalendarClock className="h-3 w-3" />
                        每天 {wf.trigger.time}
                      </Badge>
                    ) : (
                      <Badge>
                        <Hand className="h-3 w-3" />
                        手动
                      </Badge>
                    )}
                    <Badge>{wf.nodes.length} 个节点</Badge>
                    <Badge>v{wf.version}</Badge>
                    {last ? (
                      <Badge tone={RUN_TONE[last.status]} className="ml-auto">
                        {RUN_LABEL[last.status]} · {timeAgo(last.startedAt)}
                      </Badge>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
        ) : workflows.data ? (
          <EmptyState
            icon={<WorkflowIcon className="h-6 w-6" />}
            title="还没有工作流"
            description="试试“拉代码 → 构建 → 宝塔部署 → 健康检查 → 通知”模板，把 IM 项目的发布流程固化下来。"
            action={<Button onClick={() => setCreating(true)}>从模板创建</Button>}
          />
        ) : null}
      </div>
      {creating ? <TemplateDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
