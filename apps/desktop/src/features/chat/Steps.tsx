import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronRight,
  CornerDownRight,
  Loader2,
  MessageCircleQuestion,
  ArrowRight,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import type { Approval, ToolCallRecord } from "@agentdesk/shared";
import { Button, cn } from "@agentdesk/ui";
import { AGENT_META, TOOL_LABELS } from "../../lib/agents";
import { humanActionTitle } from "../../lib/approval-display";
import { http } from "../../lib/http";
import type { LiveStep } from "./useChatStream";

function friendlyToolHint(name: string, args: unknown): string | null {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === "shell.run") return humanActionTitle(a.purpose, "处理任务文件");
  if (name === "agents.delegate" && typeof a.agent === "string")
    return AGENT_META[a.agent as keyof typeof AGENT_META]?.label ?? a.agent;
  return null;
}

function ToolStep({
  name,
  args,
  isError,
  done,
}: {
  name: string;
  args: unknown;
  isError?: boolean;
  done: boolean;
}) {
  const label = TOOL_LABELS[name] ?? "处理任务";
  const hint = friendlyToolHint(name, args);
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-[12.5px] text-muted">
      {!done ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-info" />
      ) : isError ? (
        <XCircle className="h-3.5 w-3.5 text-danger" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
      )}
      <span className="font-medium">{label}</span>
      {hint ? <span className="min-w-0 truncate text-subtle">{hint}</span> : null}
    </div>
  );
}

export function QuestionPrompt({
  approvalId,
  detail,
  options,
  index,
  total,
}: {
  approvalId: string;
  detail: string;
  options: string[];
  index?: number;
  total?: number;
}) {
  const [answer, setAnswer] = useState("");
  const queryClient = useQueryClient();
  const answerQuestion = useMutation({
    mutationFn: (text: string) => http.post<Approval>(`/approvals/${approvalId}/answer`, { text }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const skip = useMutation({
    mutationFn: () => http.post<Approval>(`/approvals/${approvalId}/answer`, { text: "跳过" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const busy = answerQuestion.isPending || skip.isPending;
  const send = (text: string) => {
    if (text.trim() && !busy) answerQuestion.mutate(text.trim());
  };
  return (
    <section
      aria-label="待回答的问题"
      className="rounded-lg border bg-surface p-4 shadow-[0_10px_30px_-20px_rgba(0,0,0,0.35)]"
    >
      <div className="mb-3 flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        <h2 className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] font-medium leading-6">
          {detail}
        </h2>
        {total && total > 1 ? (
          <span className="shrink-0 text-xs text-subtle">
            {index ?? 1}/{total}
          </span>
        ) : null}
      </div>
      {options.length > 0 ? (
        <div className="divide-y" role="group" aria-label="回答选项">
          {options.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              disabled={busy}
              onClick={() => send(option)}
              className="group flex min-h-10 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-2 text-xs text-muted">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">{option}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2 border-t pt-3">
        <input
          aria-label="其他补充"
          value={answer}
          disabled={busy}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) send(answer);
          }}
          placeholder="其他补充…"
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-subtle"
        />
        {answer.trim() ? (
          <Button
            size="sm"
            variant="primary"
            loading={answerQuestion.isPending}
            disabled={busy}
            onClick={() => send(answer)}
          >
            发送
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          loading={skip.isPending}
          onClick={() => skip.mutate()}
        >
          跳过
        </Button>
      </div>
      {answerQuestion.error || skip.error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {(answerQuestion.error ?? skip.error)?.message}
        </p>
      ) : null}
    </section>
  );
}

export function LiveSteps({
  steps,
  waiting,
}: {
  steps: LiveStep[];
  waiting?: "question" | "action";
}) {
  if (steps.length === 0) return null;
  const activity = steps.filter((step) => step.kind !== "approval");
  const running = activity.some((step) => step.kind === "tool" && !step.done);
  return (
    <div className="mb-3 space-y-1">
      {activity.length ? (
        <details className="group text-xs text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 hover:text-fg focus-visible:outline-2 focus-visible:outline-brand">
            {running ? (
              <Loader2 className={cn("h-3.5 w-3.5", !waiting && "animate-spin")} />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {waiting ? "已准备" : running ? "正在处理" : "已处理"} {activity.length} 步
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
          </summary>
          <div className="ml-2 border-l pl-3">
            {activity.map((step, i) => {
              if (step.kind === "route") {
                const meta = AGENT_META[step.agent];
                return (
                  <div key={i} className="flex items-center gap-2 py-1 text-[12.5px] text-muted">
                    <CornerDownRight className="h-3.5 w-3.5 text-brand" />
                    <meta.icon className="h-3.5 w-3.5" />
                    <span className="font-medium text-fg">{meta.label} Agent</span>
                  </div>
                );
              }
              return <ToolStep key={step.id} {...step} />;
            })}
          </div>
        </details>
      ) : null}
      {waiting ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted">
          <MessageCircleQuestion className="h-3.5 w-3.5" />
          {waiting === "question" ? "等待你的回答" : "等待你的确认"}
        </div>
      ) : null}
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
        已处理 {calls.length} 步
      </button>
      {open ? (
        <div className="mt-1 ml-2 border-l pl-3">
          {calls.map((c) => (
            <ToolStep key={c.id} name={c.name} args={c.args} isError={c.isError} done />
          ))}
        </div>
      ) : null}
    </div>
  );
}
