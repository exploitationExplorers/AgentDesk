import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronRight,
  CornerDownRight,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { ToolCallRecord } from "@agentdesk/shared";
import { Button, cn } from "@agentdesk/ui";
import { AGENT_META, TOOL_LABELS } from "../../lib/agents";
import { api } from "../../lib/api";
import type { LiveStep } from "./useChatStream";

function preview(value: unknown): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

function ToolStep({
  name,
  args,
  result,
  isError,
  done,
}: {
  name: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  done: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = TOOL_LABELS[name] ?? name;
  const delegated = name === "agents.delegate" ? (args as { agent?: string; task?: string }) : null;
  return (
    <div className="text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 py-1 text-left text-muted hover:text-fg"
      >
        {!done ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-info" />
        ) : isError ? (
          <XCircle className="h-3.5 w-3.5 text-danger" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        )}
        <span className="font-medium">{label}</span>
        {delegated?.agent ? (
          <span className="truncate text-subtle">
            → {AGENT_META[delegated.agent as keyof typeof AGENT_META]?.label ?? delegated.agent}：
            {delegated.task}
          </span>
        ) : (
          <span className="truncate font-mono text-[11px] text-subtle">{name}</span>
        )}
        <ChevronRight
          className={cn("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="mb-2 ml-5 grid gap-2">
          <pre className="max-h-40 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-[11px] text-muted">
            {preview(args)}
          </pre>
          {done ? (
            <pre
              className={cn(
                "max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-[11px]",
                isError ? "text-danger" : "text-muted",
              )}
            >
              {preview(result)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ApprovalStep({
  approvalId,
  title,
  detail,
}: {
  approvalId: string;
  title: string;
  detail: string;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals("pending"),
  });
  const pending = data?.some((a) => a.id === approvalId);
  const resolve = useMutation({
    mutationFn: (approved: boolean) => api.resolveApproval(approvalId, approved),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
  return (
    <div className="my-2 rounded-xl border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <ShieldAlert className="h-4 w-4 text-warning" />
        {title}
      </div>
      {detail ? (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11.5px] text-muted">
          {detail}
        </pre>
      ) : null}
      {pending ? (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={resolve.isPending}
            onClick={() => resolve.mutate(true)}
          >
            批准执行
          </Button>
          <Button size="sm" variant="ghost" onClick={() => resolve.mutate(false)}>
            拒绝
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-subtle">已处理</p>
      )}
    </div>
  );
}

export function LiveSteps({ steps }: { steps: LiveStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mb-3 rounded-xl border bg-surface/60 px-3 py-1.5">
      {steps.map((step, i) => {
        if (step.kind === "route") {
          const meta = AGENT_META[step.agent];
          return (
            <div key={i} className="flex items-center gap-2 py-1 text-[12.5px] text-muted">
              <CornerDownRight className="h-3.5 w-3.5 text-brand" />
              <meta.icon className="h-3.5 w-3.5" />
              <span className="font-medium text-fg">{meta.label} Agent</span>
              <span className="truncate text-subtle">{step.reason}</span>
            </div>
          );
        }
        if (step.kind === "approval") return <ApprovalStep key={i} {...step} />;
        return <ToolStep key={step.id} {...step} />;
      })}
    </div>
  );
}

export function SavedSteps({ calls }: { calls: ToolCallRecord[] }) {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[12px] text-subtle hover:text-muted"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        使用了 {calls.length} 个工具
      </button>
      {open ? (
        <div className="mt-1 rounded-xl border bg-surface/60 px-3 py-1.5">
          {calls.map((c) => (
            <ToolStep
              key={c.id}
              name={c.name}
              args={c.args}
              result={c.result}
              isError={c.isError}
              done
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
