import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Menu, PanelRight, Files } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { chatMessageContent, type AgentName } from "@agentdesk/shared";
import { http } from "../../lib/http";
import { BrowserLivePanel } from "../../components/BrowserLivePanel";
import { Markdown } from "../../components/Markdown";
import { AGENT_META } from "../../lib/agents";
import { api } from "../../lib/api";
import { chatRoute } from "../../router";
import { useUi } from "../../stores/ui";
import { Composer } from "./Composer";
import { ActionPrompt } from "./ActionPrompt";
import { ConversationList } from "./ConversationList";
import { HomeHero } from "./HomeHero";
import { SessionPanel, useSessionWorkbench } from "./SessionPanel";
import { QuestionPrompt, SavedSteps } from "./Steps";
import { ChatTimeline } from "./ChatTimeline";
import { useChatStream, type LiveStep } from "./useChatStream";
import {
  ArtifactCards,
  ChatArtifactPanel,
  LivePresentationPanel,
  LiveDocumentPanel,
  visibleArtifacts,
} from "./ChatArtifacts";
import { useTaskObservation } from "./useTaskObservation";
import { AutomationInteractions } from "../automations/AutomationInteractions";
import { AutomationFollowup } from "../automations/AutomationFollowup";
import { AutomationRecovery } from "../automations/AutomationRecovery";
import { automationIsRunning, automationStatusLabel } from "../automations/status";
import { Button } from "@agentdesk/ui";

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
  const [panelOpen, setPanelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [artifactSelection, setArtifactSelection] = useState<{
    conversationId: string;
    id: string | null;
  } | null>(null);
  const workbench = useSessionWorkbench(conversationId, agent);
  const { chatPrefill, setChatPrefill, browserPanelOpen, activeBrowserSessionId } = useUi();
  const [prefill, setPrefill] = useState<string | undefined>();
  const bottom = useRef<HTMLDivElement>(null);

  const onConversation = useCallback(
    (id: string) => void navigate({ to: "/", search: { c: id }, replace: true }),
    [navigate],
  );
  const { live, send, stop, clearConnectionError, streaming } = useChatStream(
    onConversation,
    conversationId,
  );
  const automation = workbench.data?.task?.automationId ? workbench.data.task : null;
  const queryClient = useQueryClient();
  const cancelAutomation = useMutation({
    mutationFn: (id: string) => api.cancelAutomationTask(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["session-workbench", conversationId] }),
  });
  const running =
    streaming ||
    (automation
      ? automationIsRunning(automation.automationStatus)
      : workbench.data?.activity === "running");
  const observed = useTaskObservation(
    conversationId,
    workbench.data?.task?.id,
    workbench.data?.task?.currentRunId,
    running || Boolean(automation),
    Boolean(automation),
  );
  const artifacts = visibleArtifacts(workbench.data?.artifacts ?? []);
  const selectedId =
    artifactSelection && artifactSelection.conversationId === conversationId
      ? artifactSelection.id
      : [...artifacts].reverse().find((item) => {
          const metadata = item.metadata;
          return (
            metadata &&
            typeof metadata === "object" &&
            ("slideCount" in metadata || "sectionCount" in metadata)
          );
        })?.id;
  const selectedVersion = workbench.data?.artifacts.find((item) => item.id === selectedId);
  const selectedArtifact =
    artifacts.find((item) => item.id === selectedId) ??
    (selectedVersion?.artifactKey
      ? artifacts.find((item) => item.artifactKey === selectedVersion.artifactKey)
      : undefined);
  const showAutomationPreview = Boolean(
    automation && !["completed", "cancelled"].includes(automation.automationStatus ?? ""),
  );
  const livePresentation =
    (running || showAutomationPreview) &&
    observed?.presentation &&
    (!artifactSelection || artifactSelection.conversationId !== conversationId);
  const liveDocument =
    (running || showAutomationPreview) &&
    (!artifactSelection || artifactSelection.conversationId !== conversationId)
      ? observed?.document
      : null;
  const openArtifact = (id: string | null) => {
    if (conversationId) setArtifactSelection({ conversationId, id });
    setPanelOpen(false);
  };
  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.messages(conversationId!),
    enabled: !!conversationId,
    refetchInterval: running ? 2500 : false,
  });
  const livePersisted =
    !!live &&
    messages.data?.some(
      (message) =>
        message.id === live.messageId ||
        (message.role === "assistant" && Date.parse(message.createdAt) >= live.startedAt),
    );
  useEffect(() => {
    if (live?.error && (observed || livePersisted)) clearConnectionError();
  }, [live?.error, observed, livePersisted, clearConnectionError]);
  const approvals = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: () => api.approvals("pending"),
    refetchInterval: 2500,
  });
  const liveQuestion = live?.steps
    .filter(
      (step): step is Extract<LiveStep, { kind: "approval" }> =>
        step.kind === "approval" && step.question,
    )
    .at(-1);
  const pendingId = workbench.data?.task?.pendingApprovalId;
  const pendingIds = workbench.data?.pendingApprovalIds ?? [];
  const pendingAction = approvals.data?.find(
    (item) =>
      item.kind !== "question" &&
      (item.id === pendingId ||
        pendingIds.includes(item.id) ||
        live?.steps.some((step) => step.kind === "approval" && step.approvalId === item.id)),
  );
  const pendingQuestion = approvals.data?.find(
    (item) =>
      item.kind === "question" &&
      (item.id === liveQuestion?.approvalId ||
        item.id === pendingId ||
        pendingIds.includes(item.id)),
  );
  const questionPayload =
    pendingQuestion?.payload && typeof pendingQuestion.payload === "object"
      ? (pendingQuestion.payload as Record<string, unknown>)
      : null;
  const questionOptions = Array.isArray(questionPayload?.options)
    ? questionPayload.options.filter(
        (option): option is string | { title: string; description?: string } =>
          typeof option === "string" ||
          (typeof option === "object" &&
            option !== null &&
            typeof (option as { title?: unknown }).title === "string"),
      )
    : [];
  const questionIndex =
    typeof questionPayload?.index === "number" ? questionPayload.index : undefined;
  const questionTotal =
    typeof questionPayload?.total === "number" ? questionPayload.total : undefined;

  useEffect(() => {
    if (!chatPrefill) return;
    if (chatPrefill.agent) setAgent(chatPrefill.agent as AgentName);
    setPrefill(chatPrefill.message);
    setChatPrefill(null);
  }, [chatPrefill, setChatPrefill]);

  useEffect(() => setHistoryOpen(false), [conversationId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.data, live?.text, live?.steps.length, observed?.text]);

  const handleSend = (text: string, forced?: AgentName) => {
    setPrefill(undefined);
    setArtifactSelection(null);
    void send(
      text,
      conversationId,
      (forced ?? agent) === "orchestrator" ? undefined : (forced ?? agent),
    );
  };

  const composer = (
    <Composer
      onSend={(t) => handleSend(t)}
      onStop={() => {
        if (streaming) void stop();
        else if (automation) cancelAutomation.mutate(automation.id);
        else if (workbench.data?.task?.currentRunId)
          void http.post(`/runs/${encodeURIComponent(workbench.data.task.currentRunId)}/cancel`);
      }}
      streaming={running}
      disabled={
        compacting ||
        Boolean(automation) ||
        workbench.data?.activity === "compacting" ||
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
    <div className="relative flex h-full min-w-0">
      {historyOpen ? (
        <button
          type="button"
          aria-label="关闭会话列表"
          className="absolute inset-0 z-20 bg-fg/20 lg:hidden"
          onClick={() => setHistoryOpen(false)}
        />
      ) : null}
      <div className={`${historyOpen ? "absolute inset-y-0 left-0 z-30 flex" : "hidden"} lg:flex`}>
        <ConversationList activeId={conversationId} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {empty || !conversationId ? (
          <div className="flex min-h-12 items-center border-b px-4 lg:hidden">
            <button
              type="button"
              aria-label="打开会话列表"
              title="会话列表"
              onClick={() => setHistoryOpen(true)}
              className="rounded-md p-2 text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
            >
              <Menu className="h-4 w-4" />
            </button>
            <span className="ml-2 truncate text-sm font-medium">
              {workbench.data?.conversation.title ?? "对话"}
            </span>
          </div>
        ) : null}
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
              <div className="flex min-h-12 items-center justify-between border-b px-4 py-2 sm:px-6">
                <button
                  type="button"
                  aria-label="打开会话列表"
                  title="会话列表"
                  onClick={() => setHistoryOpen(true)}
                  className="mr-2 rounded-md p-2 text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand lg:hidden"
                >
                  <Menu className="h-4 w-4" />
                </button>
                <h1 className="min-w-0 truncate text-sm font-semibold">
                  {workbench.data?.conversation.title ?? "对话"}
                </h1>
                <div className="flex shrink-0 items-center">
                  {artifacts.length || observed?.presentation || observed?.document ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (livePresentation || liveDocument || selectedArtifact)
                          openArtifact(null);
                        else if (observed?.presentation || observed?.document) {
                          setArtifactSelection(null);
                          setPanelOpen(false);
                        } else openArtifact(artifacts.at(-1)!.id);
                      }}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2"
                      aria-label="查看成果"
                    >
                      <Files className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">
                        {observed?.presentation || observed?.document
                          ? "查看预览"
                          : `成果 ${artifacts.length}`}
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-pressed={panelOpen}
                    onClick={() => {
                      if (conversationId) setArtifactSelection({ conversationId, id: null });
                      setPanelOpen((open) => !open);
                    }}
                    title="会话状态"
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                  >
                    <PanelRight className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">会话状态</span>
                  </button>
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-[860px] flex-col gap-7 px-4 py-7 sm:px-8 sm:py-9">
                {(messages.data ?? []).map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[88%] whitespace-pre-wrap rounded-lg rounded-tr-sm bg-surface-2 px-4 py-2.5 text-[14px] leading-6 sm:max-w-[80%]">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex min-w-0 flex-col gap-2">
                      <div className="flex items-center gap-2 text-[13px] font-semibold">
                        <AgentAvatar agent={m.agent} />
                        {AGENT_META[m.agent ?? "orchestrator"].label}
                      </div>
                      <div className="min-w-0 flex-1 pl-0 sm:pl-9">
                        {m.display?.length ? (
                          <ChatTimeline blocks={m.display} />
                        ) : (
                          <>
                            <SavedSteps calls={m.toolCalls} />
                            <Markdown>{chatMessageContent(m.content)}</Markdown>
                          </>
                        )}
                      </div>
                    </div>
                  ),
                )}
                {live && !livePersisted ? (
                  <>
                    {!messages.data?.some(
                      (m) => m.content === live.userMessage && m.role === "user",
                    ) ? (
                      <div className="flex justify-end">
                        <div className="max-w-[88%] whitespace-pre-wrap rounded-lg rounded-tr-sm bg-surface-2 px-4 py-2.5 text-[14px] leading-6 sm:max-w-[80%]">
                          {live.userMessage}
                        </div>
                      </div>
                    ) : null}
                    <div className="flex min-w-0 flex-col gap-2">
                      <div className="flex items-center gap-2 text-[13px] font-semibold">
                        <AgentAvatar agent={live.agent} />
                        {AGENT_META[live.agent ?? "orchestrator"].label}
                      </div>
                      <div className="min-w-0 flex-1 pl-0 sm:pl-9">
                        <ChatTimeline
                          blocks={live.progress.blocks}
                          phase={live.progress.phase}
                          status={live.progress.status}
                          progress={observed?.progress}
                          waiting={
                            pendingQuestion ? "question" : pendingAction ? "action" : undefined
                          }
                        />
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
                {!live && running ? (
                  <div className="space-y-2" aria-live="polite">
                    <ChatTimeline
                      blocks={observed?.timeline.blocks ?? []}
                      phase={observed?.timeline.phase ?? "thinking"}
                      status={observed?.timeline.status}
                      progress={observed?.progress}
                      waiting={pendingQuestion ? "question" : pendingAction ? "action" : undefined}
                    />
                  </div>
                ) : null}
                {automation ? (
                  <div className="space-y-3">
                    {!running ? (
                      <p role="status" className="text-sm text-muted">
                        {automationStatusLabel(automation.automationStatus ?? "queued")}
                      </p>
                    ) : null}
                    <AutomationInteractions taskId={automation.id} />
                  </div>
                ) : null}
                <ArtifactCards artifacts={artifacts} onOpen={openArtifact} />
                <div ref={bottom} />
              </div>
            </div>
            <div className="mx-auto w-full max-w-[860px] px-4 pb-4 sm:px-8 sm:pb-5">
              {automation ? (
                <div className="space-y-2 rounded-xl border bg-surface p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <Link to="/automations" className="rounded px-1 py-2 hover:text-brand">
                      查看自动化与运行记录
                    </Link>
                    {!["completed", "cancelled"].includes(automation.automationStatus ?? "") ? (
                      <div className="space-y-1">
                        <Button
                          size="sm"
                          disabled={cancelAutomation.isPending}
                          onClick={() => cancelAutomation.mutate(automation.id)}
                        >
                          {cancelAutomation.isPending ? "正在请求停止…" : "停止任务及后续触发"}
                        </Button>
                        <p>将停用此自动化，保留已有会话与成果。</p>
                      </div>
                    ) : null}
                  </div>
                  {cancelAutomation.error ? (
                    <p role="alert" className="text-xs text-danger">
                      {cancelAutomation.error.message}
                    </p>
                  ) : null}
                  {automation.automationStatus === "needs_attention" ? (
                    <AutomationRecovery
                      taskId={automation.id}
                      conversationId={automation.conversationId}
                    />
                  ) : null}
                  {automation.automationStatus === "completed" ? (
                    <AutomationFollowup
                      key={automation.currentRunId}
                      taskId={automation.id}
                      conversationId={automation.conversationId}
                    />
                  ) : null}
                </div>
              ) : pendingQuestion ? (
                <QuestionPrompt
                  key={pendingQuestion.id}
                  approvalId={pendingQuestion.id}
                  detail={pendingQuestion.detail}
                  options={questionOptions}
                  index={questionIndex}
                  total={questionTotal}
                />
              ) : pendingAction ? (
                <ActionPrompt key={pendingAction.id} approval={pendingAction} />
              ) : (
                composer
              )}
            </div>
          </>
        )}
      </div>
      {liveDocument && !showBrowser ? (
        <LiveDocumentPanel document={liveDocument} onClose={() => openArtifact(null)} />
      ) : livePresentation && !showBrowser ? (
        <LivePresentationPanel
          slides={observed?.slides ?? []}
          progress={
            automation && !running
              ? automationStatusLabel(automation.automationStatus ?? "queued")
              : (observed?.progress ?? null)
          }
          title={observed?.presentationTitle}
          onClose={() => openArtifact(null)}
        />
      ) : selectedArtifact && !showBrowser ? (
        <ChatArtifactPanel
          key={selectedArtifact.id}
          artifact={selectedArtifact}
          artifacts={artifacts}
          onSelect={openArtifact}
          onClose={() => openArtifact(null)}
        />
      ) : null}
      {conversationId && panelOpen && !showBrowser && !selectedArtifact ? (
        <div className="absolute inset-y-0 right-0 z-30 flex shadow-lg xl:static xl:shadow-none">
          <SessionPanel
            key={conversationId}
            conversationId={conversationId}
            agent={agent}
            streaming={streaming}
            compacting={compacting}
            onCompacting={setCompacting}
          />
        </div>
      ) : null}
      {showBrowser ? <BrowserLivePanel sessionId={activeBrowserSessionId!} /> : null}
    </div>
  );
}
