import { Loader2, Check, CircleAlert, MessageCircleQuestion } from "lucide-react";
import type { ChatDisplayBlock, ChatProgress } from "@agentdesk/shared";
import { Markdown } from "../../components/Markdown";
import { TOOL_LABELS } from "../../lib/agents";

export function ChatTimeline({
  blocks,
  phase = "idle",
  waiting,
  progress,
  status,
}: {
  blocks: ChatDisplayBlock[];
  phase?: ChatProgress["phase"];
  waiting?: "question" | "action";
  progress?: string | null;
  status?: string | null;
}) {
  return (
    <div className="space-y-4" aria-label="任务进展">
      {blocks.map((block, index) =>
        block.kind === "text" ? (
          <Markdown key={index}>{block.text}</Markdown>
        ) : (
          <div key={index} className="flex items-center gap-2 text-[13px] text-muted">
            {block.status === "complete" ? (
              <Check className="h-3.5 w-3.5" />
            ) : block.status === "failed" ? (
              <CircleAlert className="h-3.5 w-3.5" />
            ) : (
              <Loader2
                className={`h-3.5 w-3.5 ${waiting || phase === "idle" ? "" : "animate-spin"}`}
              />
            )}
            {TOOL_LABELS[block.name] ?? "处理任务"}
            {block.status === "failed" ? " · 未完成" : ""}
          </div>
        ),
      )}
      {waiting ? (
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
          <MessageCircleQuestion className="h-4 w-4" />
          {waiting === "question" ? "等待你的回答" : "等待你的确认"}
        </p>
      ) : phase !== "idle" && phase !== "writing" ? (
        <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {phase === "thinking" ? (status ?? "思考中…") : (progress ?? "正在处理…")}
        </p>
      ) : null}
    </div>
  );
}
