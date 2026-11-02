import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Code2, PanelRight, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentName } from "@agentdesk/shared";
import { BrowserLivePanel } from "../../components/BrowserLivePanel";
import { Markdown } from "../../components/Markdown";
import { AGENT_META } from "../../lib/agents";
import { api } from "../../lib/api";
import { chatRoute } from "../../router";
import { useUi } from "../../stores/ui";
import { Composer } from "./Composer";
import { ConversationList } from "./ConversationList";
import { HomeHero } from "./HomeHero";
import { SessionPanel, useSessionWorkbench } from "./SessionPanel";
import { LiveSteps, SavedSteps } from "./Steps";
import { useChatStream } from "./useChatStream";

function AgentAvatar({ agent }: { agent: AgentName | null }) {
  const meta = AGENT_META[agent ?? "orchestrator"];
  return (
    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border bg-surface-2 text-brand">
      <meta.icon className="h-3.5 w-3.5" />
    </div>
  );
}

export function ChatPage() {
  const { c: conversationId } = chatRoute.useSearch();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<AgentName>("orchestrator");
  const [panelOpen, setPanelOpen] = useState(true);
  const [compacting, setCompacting] = useState(false);
  const workbench = useSessionWorkbench(conversationId, agent);
  const { chatPrefill, setChatPrefill, browserPanelOpen, activeBrowserSessionId } = useUi();
  const [prefill, setPrefill] = useState<string | undefined>();
  const bottom = useRef<HTMLDivElement>(null);

  const onConversation = useCallback(
    (id: string) => void navigate({ to: "/", search: { c: id }, replace: true }),
    [navigate],
  );
  const { live, send, stop, streaming } = useChatStream(onConversation);
  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.messages(conversationId!),
    enabled: !!conversationId,
  });

  useEffect(() => {
    if (!chatPrefill) return;
    if (chatPrefill.agent) setAgent(chatPrefill.agent as AgentName);
    setPrefill(chatPrefill.message);
    setChatPrefill(null);
  }, [chatPrefill, setChatPrefill]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.data, live?.text, live?.steps.length]);

  const handleSend = (text: string, forced?: AgentName) => {
    setPrefill(undefined);
    void send(
      text,
      conversationId,
      (forced ?? agent) === "orchestrator" ? undefined : (forced ?? agent),
    );
  };

  const composer = (
    <Composer
      onSend={(t) => handleSend(t)}
      onStop={stop}
      streaming={streaming}
      disabled={
        compacting ||
        (!streaming && !!workbench.data?.activity) ||
        workbench.data?.task?.purpose === "reference_analysis"
      }
      agent={agent}
      onAgentChange={setAgent}
      initial={prefill}
      autoFocus
      large={!conversationId && !live}
    />
  );

  const empty = !conversationId && !live;
  const showBrowser = browserPanelOpen && !!activeBrowserSessionId;
  return (
    <div className="flex h-full">
      <ConversationList activeId={conversationId} />
      <div className="flex min-w-0 flex-1 flex-col">
        {empty ? (
          <HomeHero
            composer={composer}
            onPick={(prompt, a) => {
              if (a) setAgent(a as AgentName);
              handleSend(prompt, a as AgentName | undefined);
            }}
          />
        ) : (
          <>
            {conversationId && (
              <div className="flex justify-end border-b px-6 py-2">
                <button
                  type="button"
                  aria-pressed={panelOpen}
                  onClick={() => setPanelOpen((open) => !open)}
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <PanelRight className="h-3.5 w-3.5" />
                  会话状态
                </button>
                <Link
                  to="/code"
                  search={{ c: conversationId, source: "workbench" }}
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <Code2 className="h-3.5 w-3.5" />
                  在编码现场查看
                </Link>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
                {(messages.data ?? []).map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end gap-3">
                      <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-surface-2 px-4 py-2.5 text-[14px] leading-6">
                        {m.content}
                      </div>
                      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
                        <User className="h-3.5 w-3.5" />
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3">
                      <AgentAvatar agent={m.agent} />
                      <div className="min-w-0 flex-1">
                        <SavedSteps calls={m.toolCalls} />
                        <Markdown>{m.content}</Markdown>
                      </div>
                    </div>
                  ),
                )}
                {live ? (
                  <>
                    {!messages.data?.some(
                      (m) => m.content === live.userMessage && m.role === "user",
                    ) ? (
                      <div className="flex justify-end">
                        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-surface-2 px-4 py-2.5 text-[14px] leading-6">
                          {live.userMessage}
                        </div>
                      </div>
                    ) : null}
                    <div className="flex gap-3">
                      <AgentAvatar agent={live.agent} />
                      <div className="min-w-0 flex-1">
                        <LiveSteps steps={live.steps} />
                        {live.text ? (
                          <Markdown>{live.text}</Markdown>
                        ) : !live.error ? (
                          <div className="flex gap-1 py-2">
                            {[0, 1, 2].map((i) => (
                              <span
                                key={i}
                                className="h-1.5 w-1.5 rounded-full bg-muted animate-pulse-soft"
                                style={{ animationDelay: `${i * 0.2}s` }}
                              />
                            ))}
                          </div>
                        ) : null}
                        {live.error ? (
                          <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-danger">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            {live.error}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : null}
                <div ref={bottom} />
              </div>
            </div>
            <div className="mx-auto w-full max-w-3xl px-6 pb-5">{composer}</div>
          </>
        )}
      </div>
      {conversationId && panelOpen && !showBrowser ? (
        <SessionPanel
          key={conversationId}
          conversationId={conversationId}
          agent={agent}
          streaming={streaming}
          compacting={compacting}
          onCompacting={setCompacting}
        />
      ) : null}
      {showBrowser ? <BrowserLivePanel sessionId={activeBrowserSessionId!} /> : null}
    </div>
  );
}
