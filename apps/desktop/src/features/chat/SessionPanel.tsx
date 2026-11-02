import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Dialog } from "@agentdesk/ui";
import type {
  AgentName,
  ConversationContextStatus,
  SessionWorkbench,
  TaskStatus,
} from "@agentdesk/shared";
import { http } from "../../lib/http";
import { ArtifactWorkspace } from "../code/ArtifactWorkspace";

const statuses: Record<TaskStatus, string> = {
  pending: "待开始",
  queued: "排队中",
  planning: "规划中",
  awaiting_plan_approval: "等待方案审批",
  running: "执行中",
  awaiting_review: "等待验收",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  closed: "已关闭",
};
const number = (value: number) => value.toLocaleString("zh-CN");

export function useSessionWorkbench(conversationId?: string, agent?: AgentName) {
  return useQuery({
    queryKey: ["session-workbench", conversationId, agent],
    queryFn: () =>
      http.get<SessionWorkbench>(
        `/conversations/${encodeURIComponent(conversationId!)}/workbench`,
        { agent },
      ),
    enabled: !!conversationId,
    refetchInterval: 2500,
  });
}

export function SessionPanel({
  conversationId,
  agent,
  streaming,
  compacting = false,
  onCompacting,
}: {
  conversationId: string;
  agent: AgentName;
  streaming: boolean;
  compacting?: boolean;
  onCompacting: (value: boolean) => void;
}) {
  const state = useSessionWorkbench(conversationId, agent);
  const client = useQueryClient();
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const compact = useMutation({
    mutationFn: () =>
      http.post<ConversationContextStatus>(
        `/conversations/${encodeURIComponent(conversationId)}/compact?agent=${agent}`,
      ),
    onMutate: () => onCompacting(true),
    onSettled: () => {
      onCompacting(false);
      void client.invalidateQueries({ queryKey: ["session-workbench", conversationId] });
    },
  });
  const data = state.data;
  const context = data?.context;
  const usage = data?.latestUsage;
  const busy = streaming || compacting || !!data?.activity || compact.isPending;
  return (
    <aside
      aria-label="会话状态"
      className="flex w-[280px] shrink-0 flex-col gap-5 overflow-y-auto border-l bg-surface/40 p-4 text-xs"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">会话状态</h2>
        <span className="text-muted">
          {data?.activity === "compacting" || compact.isPending
            ? "正在压缩"
            : busy
              ? "执行中"
              : "就绪"}
        </span>
      </div>
      {state.error && (
        <p role="alert" className="text-danger">
          {state.error.message}
        </p>
      )}
      <section className="space-y-2">
        <h3 className="font-medium">工作环境</h3>
        <p className="break-all text-muted">{data?.workspace ?? "尚未关联项目"}</p>
        <p className="break-all text-muted">{context?.model ?? "尚未配置模型"}</p>
      </section>
      {data?.task && (
        <section className="space-y-2">
          <h3 className="font-medium">当前任务 · {statuses[data.task.status]}</h3>
          <p className="text-muted">{data.task.title}</p>
          <p>
            {data.runs.filter((run) => run.status === "succeeded").length} / {data.runs.length}{" "}
            次运行完成 · {data.pendingApprovals} 项待审批
          </p>
          <Link
            to="/code"
            search={{ c: conversationId, source: "workbench" }}
            className="text-brand"
          >
            查看执行与审批 →
          </Link>
        </section>
      )}
      <section className="space-y-3">
        <h3 className="font-medium">上下文预算</h3>
        {context ? (
          <>
            <p className="text-muted">
              窗口 {number(context.contextWindow)} tokens ·{" "}
              {context.capacitySource === "configured" ? "已配置" : "默认容量"}
            </p>
            <progress
              aria-label="上下文预算占用"
              className="h-2 w-full accent-[var(--ad-brand)]"
              max={Math.max(1, context.inputBudgetTokens)}
              value={Math.min(context.estimatedInputTokens, context.inputBudgetTokens)}
            />
            <p>
              估算 {number(context.estimatedInputTokens)} / {number(context.inputBudgetTokens)}{" "}
              tokens
            </p>
            <p className="leading-5 text-muted">
              包含系统与工具预留；这是预算估算。原始记录 {context.messageCount} 条，已摘要{" "}
              {context.summarizedMessages} 条，直接保留 {context.retainedMessages} 条。
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !context.model || context.messageCount <= 6}
              onClick={() => compact.mutate()}
            >
              {compact.isPending ? "正在压缩…" : "压缩较早内容"}
            </Button>
            {compact.isSuccess && (
              <p role="status" className="text-muted">
                压缩完成，原始消息仍可查看。
              </p>
            )}
            {context.summary && (
              <details className="rounded-lg border p-2">
                <summary className="cursor-pointer font-medium">查看会话摘要</summary>
                <p className="mt-3 whitespace-pre-wrap">{context.summary.goal}</p>
                {(
                  [
                    ["约束", context.summary.constraints],
                    ["决定", context.summary.decisions],
                    ["事实", context.summary.facts],
                    ["未完成", context.summary.pending],
                  ] as const
                ).map(
                  ([label, items]) =>
                    items.length > 0 && (
                      <div key={label} className="mt-3">
                        <h4 className="font-medium">{label}</h4>
                        <ul className="mt-1 list-disc space-y-1 pl-4 text-muted">
                          {items.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ),
                )}
              </details>
            )}
          </>
        ) : (
          <p className="text-muted">{data?.contextError ?? "正在读取上下文…"}</p>
        )}
        {compact.error && (
          <p role="alert" className="text-danger">
            {compact.error.message}
          </p>
        )}
        {data?.lastCompaction && <p className="text-muted">{data.lastCompaction.message}</p>}
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">最近一次模型用量</h3>
        {usage ? (
          <>
            <p className="break-all text-muted">{usage.model}</p>
            <p className="text-muted">
              {usage.purpose === "compaction"
                ? "上下文摘要"
                : usage.purpose === "analysis"
                  ? "资料分析"
                  : "会话响应"}
            </p>
            <p>
              输入 {number(usage.inputTokens)} · 输出 {number(usage.outputTokens)}
            </p>
            <p className="text-muted">
              缓存读取 {number(usage.cacheReadTokens)} · 写入 {number(usage.cacheWriteTokens)}
            </p>
            <p className="text-muted">模型实际返回的用量，非整段会话累计。</p>
          </>
        ) : (
          <p className="text-muted">模型响应后显示真实用量。</p>
        )}
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">最近使用的工具</h3>
        <p className="break-all leading-5 text-muted">
          {data?.usedTools.join("、") || "暂无工具调用"}
        </p>
      </section>
      {data?.task && (
        <Button size="sm" variant="secondary" onClick={() => setArtifactsOpen(true)}>
          查看成果（{data.artifacts.length}）
        </Button>
      )}
      <Dialog
        open={artifactsOpen}
        onOpenChange={setArtifactsOpen}
        title="会话成果"
        className="w-[min(1000px,94vw)]"
      >
        {data?.task && <ArtifactWorkspace taskId={data.task.id} />}
      </Dialog>
    </aside>
  );
}
