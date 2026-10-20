import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentName } from "@agentdesk/shared";
import { cn } from "@agentdesk/ui";
import { AGENT_META } from "../../lib/agents";

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
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  agent: AgentName;
  onAgentChange: (agent: AgentName) => void;
  initial?: string;
  autoFocus?: boolean;
  large?: boolean;
}) {
  const [text, setText] = useState(initial ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);

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
    if (!value || streaming) return;
    onSend(value);
    setText("");
  };

  return (
    <div
      className={cn(
        "rounded-3xl border border-border-strong/70 bg-surface shadow-[0_8px_40px_-12px_rgba(0,0,0,0.5)] transition-colors focus-within:border-subtle",
        large && "shadow-[0_20px_80px_-20px_color-mix(in_oklab,var(--ad-brand)_35%,transparent)]",
      )}
    >
      <textarea
        ref={ref}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={large ? 2 : 1}
        placeholder="问我任何事：部署 IM 项目、今天 GitHub 有什么新东西、哪些项目还没提交…"
        className="block max-h-[220px] w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[14.5px] leading-6 text-fg outline-none placeholder:text-subtle"
      />
      <div className="flex items-center gap-1.5 px-3 pb-3">
        {AGENT_ORDER.map((name) => {
          const meta = AGENT_META[name];
          const active = agent === name;
          return (
            <button
              key={name}
              type="button"
              title={meta.description}
              onClick={() => onAgentChange(name)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
                active
                  ? "border-border-strong bg-surface-2 text-fg"
                  : "border-transparent text-subtle hover:text-muted",
              )}
            >
              <meta.icon className="h-3.5 w-3.5" />
              {name === "orchestrator" ? "自动" : meta.label}
            </button>
          );
        })}
        <div className="ml-auto">
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="停止"
              className="grid h-9 w-9 place-items-center rounded-full bg-accent text-accent-fg hover:opacity-90"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              aria-label="发送"
              className="grid h-9 w-9 place-items-center rounded-full bg-accent text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
