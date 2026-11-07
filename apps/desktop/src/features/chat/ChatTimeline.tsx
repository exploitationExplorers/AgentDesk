import { useEffect, useState } from "react";
import {
  Loader2,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  MessageCircleQuestion,
} from "lucide-react";
import {
  parseAgentDeskSegments,
  type ChatDisplayBlock,
  type ChatProgress,
} from "@agentdesk/shared";
import { AnimatedDisclosure, cn } from "@agentdesk/ui";
import { Markdown } from "../../components/Markdown";
import { TOOL_LABELS } from "../../lib/agents";
import { DisplayCard } from "./DisplayCards";
import { LoadingTip } from "./LoadingTip";

function activityLabel(name: string): string {
  return TOOL_LABELS[name] ?? "处理任务";
}

function ActivityRow({
  block,
  spinning,
}: {
  block: Extract<ChatDisplayBlock, { kind: "activity" }>;
  spinning: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-[13px] text-muted">
      {block.status === "complete" ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
      ) : block.status === "failed" ? (
        <CircleAlert className="h-3.5 w-3.5 shrink-0 text-danger" />
      ) : spinning ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">
        {activityLabel(block.name)}
        {block.status === "failed" ? " · 未完成" : ""}
      </span>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

function ElapsedLabel({ active }: { active: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [active]);
  if (!active || seconds < 1) return null;
  return <span className="text-[12px] text-subtle">已处理 {formatElapsed(seconds)}</span>;
}

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
  const [stepsOpen, setStepsOpen] = useState(false);
  const activities = blocks.filter(
    (block): block is Extract<ChatDisplayBlock, { kind: "activity" }> => block.kind === "activity",
  );
  const askUserIds = new Set(
    activities.filter((block) => block.name === "tasks.ask_user").map((block) => block.id),
  );
  const completed = activities.filter(
    (block) => block.status !== "running" || (waiting && askUserIds.has(block.id)),
  );
  const running = activities.filter(
    (block) => block.status === "running" && !(waiting && askUserIds.has(block.id)),
  );
  const working = !waiting && phase !== "idle";

  return (
    <div className="space-y-3" aria-label="任务进展">
      {blocks.map((block, index) => {
        if (block.kind !== "text") return null;
        return parseAgentDeskSegments(block.text).map((segment, segmentIndex) =>
          segment.kind === "markdown" ? (
            <Markdown key={`text-${index}-${segmentIndex}`}>{segment.text}</Markdown>
          ) : (
            <DisplayCard key={`card-${index}-${segmentIndex}`} data={segment.data} />
          ),
        );
      })}

      {working || waiting || completed.length > 0 || running.length > 0 ? (
        <div className="space-y-1.5">
          {working ? (
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-[12px] text-muted"
              role="status"
            >
              <ElapsedLabel active={working} />
              {!running.length ? (
                <span className="flex items-center gap-1.5">
                  <span
                    className="mr-1 inline-flex items-center gap-0.5 text-brand"
                    aria-hidden="true"
                  >
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="chat-progress-dot h-1 w-1 rounded-full bg-current"
                      />
                    ))}
                  </span>
                  {phase === "thinking" ? (status ?? "思考中…") : (progress ?? "正在处理…")}
                </span>
              ) : null}
              <LoadingTip active={working} />
            </div>
          ) : null}

          {completed.length > 0 ? (
            <div className="rounded-2xl border border-border/60 bg-surface/70 px-3.5 py-2">
              <button
                type="button"
                onClick={() => setStepsOpen((open) => !open)}
                className="flex w-full items-center gap-1.5 py-1 text-left text-[12.5px] text-muted hover:text-fg"
                aria-expanded={stepsOpen}
              >
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                <span className="min-w-0 flex-1">已完成 {completed.length} 步</span>
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 transition-transform",
                    stepsOpen && "rotate-90",
                  )}
                />
              </button>
              <AnimatedDisclosure open={stepsOpen}>
                <div className="mb-1 ml-1 border-l border-border/80 pl-3">
                  {completed.map((block) => (
                    <ActivityRow
                      key={block.id}
                      block={block.status === "running" ? { ...block, status: "complete" } : block}
                      spinning={false}
                    />
                  ))}
                </div>
              </AnimatedDisclosure>
            </div>
          ) : null}

          {running.map((block) => (
            <ActivityRow key={block.id} block={block} spinning />
          ))}

          {waiting ? (
            <p role="status" className="flex items-center gap-2.5 text-[13px] text-muted">
              <MessageCircleQuestion className="h-4 w-4 shrink-0" />
              {waiting === "question" ? "等待你的回答" : "等待你的确认"}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
