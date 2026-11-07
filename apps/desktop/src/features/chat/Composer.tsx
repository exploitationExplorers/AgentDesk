import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp, Settings2, Square, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentName, ConversationContextStatus } from "@agentdesk/shared";
import { AnimatePresence, ChoiceMenu, cn, motion, useReducedMotion } from "@agentdesk/ui";
import { ModelBrandIcon } from "../../components/ModelBrandIcon";
import { AGENT_META } from "../../lib/agents";
import { api } from "../../lib/api";

const AGENT_ORDER: AgentName[] = ["orchestrator", "project", "deploy", "research", "code"];

export function Composer({
  onSend,
  onStop,
  streaming,
  agent,
  onAgentChange,
  initial,
  autoFocus,
  large,
  disabled = false,
  context,
  onOpenContext,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  agent: AgentName;
  onAgentChange?: (agent: AgentName) => void;
  initial?: string;
  autoFocus?: boolean;
  large?: boolean;
  disabled?: boolean;
  context?: ConversationContextStatus | null;
  onOpenContext?: () => void;
}) {
  const [text, setText] = useState(initial ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const reduced = useReducedMotion();
  const bindings = useQuery({ queryKey: ["bindings"], queryFn: api.bindings });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const own = bindings.data?.find((item) => item.agent === agent);
  const binding = own?.model ? own : bindings.data?.find((item) => item.agent === "orchestrator");
  const model = context?.model ?? binding?.model;
  const provider = providers.data?.find(
    (item) => item.id === (context?.providerId ?? binding?.providerId),
  );
  const percent = context
    ? Math.min(
        100,
        Math.round((context.estimatedInputTokens / Math.max(1, context.inputBudgetTokens)) * 100),
      )
    : null;

  useEffect(() => {
    if (initial) setText(initial);
  }, [initial]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || streaming || disabled) return;
    onSend(value);
    setText("");
    ref.current?.focus();
  };

  return (
    <div
      className={cn("chat-composer", large && "chat-composer-large")}
      data-busy={streaming || undefined}
    >
      <textarea
        ref={ref}
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={large ? 3 : 2}
        placeholder={
          streaming ? "任务进行中，可先写下接下来的想法…" : "描述你的想法，让 Agent 帮你完成。"
        }
        aria-label="发送消息"
        className="block max-h-[220px] min-h-[76px] w-full resize-none bg-transparent px-5 pt-5 pb-3 text-[14px] leading-7 text-fg outline-none placeholder:text-subtle disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="flex min-w-0 items-center gap-1 px-3 pb-3">
        <ChoiceMenu
          label="选择 Agent"
          value={agent}
          options={(onAgentChange ? AGENT_ORDER : [agent]).map((name) => {
            const meta = AGENT_META[name];
            return {
              value: name,
              label: name === "orchestrator" ? "自动调度" : `${meta.label} Agent`,
              description: meta.description,
              icon:
                name === "orchestrator" ? (
                  <Sparkles className="h-3.5 w-3.5" />
                ) : (
                  <meta.icon className="h-3.5 w-3.5" />
                ),
            };
          })}
          onChange={(value) => onAgentChange?.(value)}
          disabled={!onAgentChange || streaming || disabled}
          className="shrink-0 bg-brand/6 text-brand"
        />
        <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
        <Link
          to="/settings"
          search={{ tab: "bindings" }}
          aria-label="配置 Agent 模型"
          title={model ? `当前模型：${model}，点击配置` : "配置 Agent 模型"}
          className="flex h-9 min-w-0 items-center gap-1.5 rounded-xl px-2 text-[11px] text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-brand"
        >
          {model ? (
            <ModelBrandIcon
              model={model}
              baseUrl={provider?.baseUrl}
              api={provider?.api}
              size={14}
            />
          ) : (
            <Settings2 className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="hidden max-w-[160px] truncate sm:inline">{model ?? "配置模型"}</span>
        </Link>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {percent !== null && onOpenContext ? (
            <button
              type="button"
              onClick={onOpenContext}
              aria-label={`查看上下文预算，已用 ${percent}%`}
              title={`上下文预算估算：${percent}%`}
              className="flex h-9 items-center gap-1.5 rounded-xl px-2 text-[11px] tabular-nums text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 20 20"
                className={percent >= 85 ? "text-warning" : "text-brand"}
                aria-hidden="true"
              >
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  opacity="0.15"
                />
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  pathLength="100"
                  strokeDasharray={`${percent} 100`}
                  strokeLinecap="round"
                  transform="rotate(-90 10 10)"
                />
              </svg>
              <span className="hidden sm:inline">{percent}%</span>
            </button>
          ) : null}
          <motion.button
            type="button"
            onClick={streaming ? onStop : submit}
            disabled={!streaming && (!text.trim() || disabled)}
            aria-label={streaming ? "停止" : "发送"}
            whileTap={reduced ? undefined : { scale: 0.91 }}
            className={cn(
              "chat-send grid h-9 w-9 place-items-center rounded-xl",
              streaming && "is-running",
            )}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={streaming ? "stop" : "send"}
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={{ duration: reduced ? 0 : 0.12 }}
              >
                {streaming ? (
                  <Square className="h-3 w-3 fill-current" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </div>
      </div>
    </div>
  );
}
