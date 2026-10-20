import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronRight,
  Circle,
  Hand,
  Loader2,
  MinusCircle,
  RotateCcw,
  Square,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DeployRun, DeployRunStatus, RunStepState } from "@agentdesk/shared";
import { Badge, Button, Card, cn } from "@agentdesk/ui";
import { useApiUrl } from "../../hooks/useApiUrl";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { subscribe } from "../../lib/http";

export const RUN_STATUS: Record<
  DeployRunStatus,
  { label: string; tone: "neutral" | "info" | "success" | "warning" | "danger" | "brand" }
> = {
  awaiting_approval: { label: "待审批", tone: "warning" },
  running: { label: "运行中", tone: "info" },
  needs_manual: { label: "需人工处理", tone: "warning" },
  succeeded: { label: "成功", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

function StepIcon({ status }: { status: RunStepState["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-info" />;
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 text-success" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-danger" />;
    case "skipped":
      return <MinusCircle className="h-4 w-4 text-subtle" />;
    default:
      return <Circle className="h-4 w-4 text-subtle" />;
  }
}

function Screenshot({
  runId,
  step,
  version,
}: {
  runId: string;
  step: RunStepState;
  version: string;
}) {
  const url = useApiUrl(
    step.screenshot ? `/deploy/runs/${runId}/screenshots/${step.index}` : null,
    { v: version },
  );
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-2 block overflow-hidden rounded-lg border"
    >
      <img src={url} alt={step.title} className="max-h-64 w-full object-cover object-top" />
    </a>
  );
}

function StepRow({
  runId,
  step,
  version,
  defaultOpen,
}: {
  runId: string;
  step: RunStepState;
  version: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const hasDetail = step.log.length > 0 || !!step.screenshot;
  return (
    <div className="relative pl-7">
      <span className="absolute left-0 top-0.5">
        <StepIcon status={step.status} />
      </span>
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 text-left text-[13px]"
      >
        <span className={cn(step.status === "pending" && "text-muted")}>{step.title}</span>
        {hasDetail ? (
          <ChevronRight
            className={cn("h-3.5 w-3.5 text-subtle transition-transform", open && "rotate-90")}
          />
        ) : null}
      </button>
      {open && hasDetail ? (
        <div className="mt-1.5 mb-1">
          {step.log.length ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono text-[11px] leading-4 text-muted">
              {step.log.join("\n")}
            </pre>
          ) : null}
          <Screenshot runId={runId} step={step} version={version} />
        </div>
      ) : null}
    </div>
  );
}

export function RunPanel({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const initial = useQuery({
    queryKey: ["deploy-run", runId],
    queryFn: () => api.deployRun(runId),
  });
  const [live, setLive] = useState<DeployRun | null>(null);

  useEffect(() => {
    setLive(null);
    return subscribe<{ type: string; run?: DeployRun }>(
      `/deploy/runs/${runId}/events`,
      (e) => {
        if (e.type === "run" && e.run) setLive(e.run);
      },
      { isFinal: (e) => !!e.run && ["succeeded", "failed", "cancelled"].includes(e.run.status) },
    );
  }, [runId]);

  const run = live ?? initial.data;
  const onDone = () => {
    void queryClient.invalidateQueries({ queryKey: ["deploy-runs"] });
    void queryClient.invalidateQueries({ queryKey: ["deploy-run", runId] });
  };
  const retry = useMutation({
    mutationFn: () => api.retryDeploy(runId),
    onSuccess: (r) => (setLive(r), onDone()),
  });
  const cancel = useMutation({ mutationFn: () => api.cancelDeploy(runId), onSuccess: onDone });

  if (!run) return null;
  const status = RUN_STATUS[run.status];
  const current = run.steps.find((s) => s.status === "running" || s.status === "failed");
  const done = run.steps.filter((s) => s.status === "succeeded").length;

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <p className="text-[14px] font-semibold">{run.recipeName}</p>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-[11.5px] text-subtle">
          {done}/{run.steps.length} · {timeAgo(run.createdAt)}
        </span>
        <div className="ml-auto flex gap-1.5">
          {run.status === "running" ||
          run.status === "needs_manual" ||
          run.status === "awaiting_approval" ? (
            <Button
              size="sm"
              variant="ghost"
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              <Square className="h-3 w-3" />
              取消
            </Button>
          ) : null}
          {run.status === "failed" ||
          run.status === "cancelled" ||
          run.status === "needs_manual" ? (
            <Button
              size="sm"
              variant="secondary"
              loading={retry.isPending}
              onClick={() => retry.mutate()}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              从失败步骤重试
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mb-4 h-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            "h-full transition-all",
            run.status === "failed" ? "bg-danger" : "bg-brand",
          )}
          style={{ width: `${run.steps.length ? (done / run.steps.length) * 100 : 0}%` }}
        />
      </div>
      {run.status === "awaiting_approval" ? (
        <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          部署需要你批准，请在右下角的审批卡片中确认。
        </p>
      ) : null}
      {run.status === "needs_manual" ? (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <Hand className="h-4 w-4" />
          {run.error ?? "需要你在弹出的浏览器窗口中完成登录（例如验证码），完成后会自动继续。"}
        </p>
      ) : null}
      {run.status === "failed" && run.error ? (
        <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {run.error}
        </p>
      ) : null}
      <div className="grid gap-3">
        {run.steps.map((s) => (
          <StepRow
            key={s.index}
            runId={run.id}
            step={s}
            version={run.updatedAt}
            defaultOpen={current?.index === s.index}
          />
        ))}
      </div>
    </Card>
  );
}
