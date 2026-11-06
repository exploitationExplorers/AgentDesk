import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import type { AutomationCard, AutoloopInteractionAnswer } from "@agentdesk/shared";
import { Button, Textarea, cn } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { clearPendingAnswer, readPendingAnswer, savePendingAnswer } from "./pending";

function InteractionCard({ card }: { card: AutomationCard }) {
  const client = useQueryClient();
  const [pending, setPending] = useState(() => {
    const saved = readPendingAnswer(card.id);
    return saved?.cardVersion === card.version ? saved : null;
  });
  const [choice, setChoice] = useState<number | undefined>(pending?.choice);
  const [text, setText] = useState(pending?.text ?? "");
  const answer = useMutation({
    mutationFn: async (input: AutoloopInteractionAnswer) => {
      const saved = readPendingAnswer(card.id);
      const request = saved?.cardVersion === card.version ? saved : input;
      savePendingAnswer(card.id, request);
      setPending(request);
      setChoice(request.choice);
      setText(request.text ?? "");
      await api.answerInteraction(card.id, request);
      return request;
    },
    onSuccess: (request) => {
      clearPendingAnswer(card.id, request.answerId);
      void client.invalidateQueries({ queryKey: ["interactions", card.taskId] });
      void client.invalidateQueries({ queryKey: ["session-workbench"] });
      void client.invalidateQueries({ queryKey: ["automation-tasks"] });
    },
    onError: () => {
      // 网络响应丢失或其他窗口已经回答时，先补齐远端状态；重试仍使用原 answerId。
      void client.invalidateQueries({ queryKey: ["interactions", card.taskId] });
    },
  });
  const open = card.state === "open" && card.kind === "ask";
  useEffect(() => {
    if (open) return;
    const saved = readPendingAnswer(card.id);
    if (saved) clearPendingAnswer(card.id, saved.answerId);
  }, [card.id, open]);
  const submit = () => {
    if (choice === undefined && !text.trim()) return;
    answer.mutate(
      pending ?? {
        cardVersion: card.version,
        answerId: crypto.randomUUID(),
        choice,
        text: text.trim() || undefined,
      },
    );
  };

  return (
    <section
      aria-label={
        open
          ? card.interactionKind === "authorization"
            ? "自动化待确认的操作"
            : "自动化待回答的问题"
          : "自动化问题记录"
      }
      className="rounded-xl border border-border bg-surface p-4"
    >
      <div className="flex items-start gap-2.5">
        {open ? (
          <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-medium">{card.title}</h3>
          {card.description ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-muted">
              {card.description}
            </p>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2" aria-label="回答选项">
            {card.options.map((option, index) => (
              <button
                key={`${index}:${option}`}
                type="button"
                aria-pressed={choice === index}
                disabled={answer.isPending || Boolean(pending)}
                onClick={() => setChoice(index)}
                className={cn(
                  "min-h-11 max-w-full break-words rounded-lg border px-3 py-2 text-left text-[13px] focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-60",
                  choice === index
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-border hover:bg-surface-2",
                )}
              >
                {option}
              </button>
            ))}
          </div>
          <Textarea
            aria-label="补充回答"
            placeholder="补充说明（可选）"
            value={text}
            maxLength={4000}
            disabled={answer.isPending || Boolean(pending)}
            onChange={(event) => setText(event.target.value)}
          />
          {pending && !answer.isPending ? (
            <p className="text-xs text-muted">上次回答尚待确认，重试会沿用同一份回答。</p>
          ) : null}
          {answer.error ? (
            <p role="alert" className="text-xs text-danger">
              {answer.error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              {card.interactionKind === "authorization"
                ? "这次选择只用于当前操作。"
                : "等待你的选择，已有成果会保留。"}
            </p>
            <Button
              variant="primary"
              disabled={
                answer.isPending ||
                (card.interactionKind === "authorization"
                  ? choice === undefined
                  : choice === undefined && !text.trim())
              }
              onClick={submit}
            >
              {answer.isPending ? "正在提交…" : "提交并继续"}
            </Button>
          </div>
        </div>
      ) : (
        <p role="status" className="mt-3 break-words text-[13px] text-muted">
          {card.state === "answered" || card.state === "decided"
            ? `已回答${card.answerText ? `：${card.answerText}` : "，等待继续处理"}`
            : card.state === "done"
              ? "已处理"
              : card.kind === "notice"
                ? "任务通知"
                : "此问题已关闭"}
        </p>
      )}
    </section>
  );
}

export function AutomationInteractions({ taskId }: { taskId: string }) {
  const query = useQuery({
    queryKey: ["interactions", taskId],
    queryFn: () => api.interactions(taskId),
    refetchInterval: 2500,
  });
  return (
    <div className="space-y-3">
      {query.error ? (
        <p role="alert" className="text-xs text-danger">
          {query.error.message}
        </p>
      ) : null}
      {query.data?.map((card) => (
        <InteractionCard key={`${card.id}:${card.version}`} card={card} />
      ))}
    </div>
  );
}
