import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  CornerDownLeft,
  Loader2,
  MessageCircleQuestion,
  Plus,
  Send,
  X,
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

export type QuestionOption = string | { title: string; description?: string };

function normalizeOption(option: QuestionOption): {
  title: string;
  description?: string;
  value: string;
} {
  if (typeof option === "string") {
    const split = option
      .split(/\n+| — |：|: /)
      .map((part) => part.trim())
      .filter(Boolean);
    if (split.length >= 2) {
      return { title: split[0]!, description: split.slice(1).join(" "), value: option };
    }
    return { title: option, value: option };
  }
  return { title: option.title, description: option.description, value: option.title };
}

/** 豆包风格：底部大卡片，多步 ‹ n / n ›，编号选项标题+副文案，自定义描述。 */
export function QuestionPrompt({
  approvalId,
  detail,
  options,
  index,
  total,
}: {
  approvalId: string;
  detail: string;
  options: QuestionOption[];
  index?: number;
  total?: number;
}) {
  const [answer, setAnswer] = useState("");
  const [step, setStep] = useState(index && index > 0 ? index : 1);
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
  const normalized = options.map(normalizeOption);
  const stepTotal = total && total > 1 ? total : 1;
  const stepIndex = Math.min(Math.max(step, 1), stepTotal);

  return (
    <section
      aria-label="待回答的问题"
      className="overflow-hidden rounded-2xl border border-[#d6e4ff] bg-surface shadow-[0_12px_40px_-24px_rgba(37,99,235,0.45)]"
    >
      <div className="flex items-start gap-3 border-b border-border/70 px-4 py-3.5">
        <h2 className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] font-medium leading-6 text-fg">
          {detail}
        </h2>
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5 text-subtle">
          {stepTotal > 1 ? (
            <>
              <button
                type="button"
                aria-label="上一个"
                disabled={busy || stepIndex <= 1}
                onClick={() => setStep((s) => Math.max(1, s - 1))}
                className="grid h-7 w-7 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[2.75rem] text-center text-xs tabular-nums">
                {stepIndex} / {stepTotal}
              </span>
              <button
                type="button"
                aria-label="下一个"
                disabled={busy || stepIndex >= stepTotal}
                onClick={() => setStep((s) => Math.min(stepTotal, s + 1))}
                className="grid h-7 w-7 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-label="关闭"
            disabled={busy}
            onClick={() => skip.mutate()}
            className="grid h-7 w-7 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {normalized.length > 0 ? (
        <div className="px-2 py-1" role="group" aria-label="回答选项">
          {normalized.map((option, optionIndex) => (
            <button
              key={`${optionIndex}-${option.value}`}
              type="button"
              disabled={busy}
              onClick={() => send(option.value)}
              className="group flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
            >
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[12px] text-muted">
                {optionIndex + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium text-fg">{option.title}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-[12.5px] leading-5 text-muted">
                    {option.description}
                  </span>
                ) : null}
              </span>
              <CornerDownLeft className="mt-1 h-4 w-4 shrink-0 text-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2 border-t border-border/70 px-3 py-2.5">
        <span className="mb-1.5 grid h-7 w-7 shrink-0 place-items-center text-subtle" aria-hidden>
          <Plus className="h-4 w-4" />
        </span>
        <input
          aria-label="自定义描述"
          value={answer}
          disabled={busy}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) send(answer);
          }}
          placeholder="自定义描述…"
          className="min-h-9 min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-subtle"
        />
        {answer.trim() ? (
          <Button
            size="icon"
            variant="primary"
            aria-label="发送"
            loading={answerQuestion.isPending}
            disabled={busy}
            onClick={() => send(answer)}
            className="mb-0.5"
          >
            <Send className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
      {answerQuestion.error || skip.error ? (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
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
