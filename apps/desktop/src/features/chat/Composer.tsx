import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentModelBinding, AgentName, Provider } from "@agentdesk/shared";
import { cn } from "@agentdesk/ui";
import { ModelBrandIcon } from "../../components/ModelBrandIcon";
import { AGENT_META } from "../../lib/agents";
import { api } from "../../lib/api";

const AGENT_ORDER: AgentName[] = ["orchestrator", "project", "deploy", "research", "code"];

function BoundModelIcon({
  agent,
  bindings,
  providers,
}: {
  agent: AgentName;
  bindings?: AgentModelBinding[];
  providers?: Provider[];
}) {
  const own = bindings?.find((item) => item.agent === agent);
  const binding = own?.model ? own : bindings?.find((item) => item.agent === "orchestrator");
  if (!binding?.model) return null;
  const provider = providers?.find((item) => item.id === binding.providerId);
  return (
    <ModelBrandIcon
      model={binding.model}
      baseUrl={provider?.baseUrl}
      api={provider?.api}
      size={14}
    />
  );
}

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
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  agent: AgentName;
  onAgentChange: (agent: AgentName) => void;
  initial?: string;
  autoFocus?: boolean;
  large?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState(initial ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const bindings = useQuery({ queryKey: ["bindings"], queryFn: api.bindings });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });

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
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-border-strong/70 bg-surface shadow-[0_8px_28px_-20px_rgba(0,0,0,0.45)] transition-colors focus-within:border-brand/70",
        large && "shadow-[0_12px_32px_-24px_rgba(0,0,0,0.45)]",
      )}
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
        rows={large ? 2 : 1}
        placeholder="今天想完成什么？"
        aria-label="发送消息"
        className="block max-h-[220px] w-full resize-none bg-transparent px-4 pt-4 pb-3 text-[14.5px] leading-6 text-fg outline-none placeholder:text-subtle"
      />
      <div className="flex items-center gap-2 px-3 pb-3">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
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
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
                  active
                    ? "border-border-strong bg-surface-2 text-fg"
                    : "border-transparent text-subtle hover:text-muted",
                )}
              >
                <meta.icon className="h-3.5 w-3.5" />
                <BoundModelIcon agent={name} bindings={bindings.data} providers={providers.data} />
                {name === "orchestrator" ? "自动" : meta.label}
              </button>
            );
          })}
        </div>
        <div className="shrink-0">
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
              disabled={!text.trim() || disabled}
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
