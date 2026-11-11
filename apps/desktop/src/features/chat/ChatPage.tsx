import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowDown, Menu, PanelRight, Files, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { chatMessageContent, type AgentName, type ModelSelection } from "@agentdesk/shared";
import { http } from "../../lib/http";
import { BrowserLivePanel } from "../../components/BrowserLivePanel";
import { Markdown } from "../../components/Markdown";
import { AGENT_META } from "../../lib/agents";
import { api } from "../../lib/api";
import { chatRoute } from "../../router";
import { useUi } from "../../stores/ui";
import { Composer, type ComposerProject } from "./Composer";
import { conversationsApi } from "./conversations-api";
import { toast } from "../../lib/toast";
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
import {
  AnimatePresence,
  Button,
  MotionConfig,
  cn,
  motion,
  surfaceTransition,
  useReducedMotion,
} from "@agentdesk/ui";
import { useChatScroll } from "./useChatScroll";
import "./chat.css";

function AgentAvatar({ agent }: { agent: AgentName | null }) {
  const meta = AGENT_META[agent ?? "orchestrator"];
  return (
    <div className="grid h-7 w-7 shrink-0 place-items-center rounded-[10px] border border-brand/10 bg-brand/7 text-brand">
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
  const [draftProject, setDraftProject] = useState<ComposerProject | null>(null);
  const reduced = useReducedMotion();

  const onConversation = useCallback(
    (id: string) => void navigate({ to: "/", search: { c: id }, replace: true }),
    [navigate],
  );
  const { live, send, stop, clearConnectionError, streaming } = useChatStream(
    onConversation,
    conversationId,
  );
  const scroll = useChatScroll(conversationId, Boolean(conversationId || live));
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
    if (conversationId) setDraftProject(null);
  }, [conversationId]);

  const linkedProjectId = conversationId
    ? (workbench.data?.conversation.projectId ?? null)
    : (draftProject?.id ?? null);

  const handleProjectChange = async (project: ComposerProject | null) => {
    if (!conversationId) {
      setDraftProject(project);
      return;
    }
    try {
      await conversationsApi.patch(conversationId, { projectId: project?.id ?? null });
      void queryClient.invalidateQueries({ queryKey: ["session-workbench", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (error) {
      toast(error instanceof Error ? error.message : "关联项目失败", { tone: "danger" });
    }
  };

  const handleSend = (text: string, forced?: AgentName, modelSelection?: ModelSelection) => {
    scroll.toBottom(false);
    setPrefill(undefined);
    setArtifactSelection(null);
    void send(
      text,
      conversationId,
      (forced ?? agent) === "orchestrator" ? undefined : (forced ?? agent),
      conversationId ? undefined : (draftProject?.path ?? undefined),
      modelSelection,
    );
  };

  const composer = (
    <Composer
      onSend={(t, options) => handleSend(t, undefined, options?.modelSelection)}
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
      context={workbench.data?.context}
      projectId={linkedProjectId}
      projectName={
        conversationId
          ? (workbench.data?.workspace?.split(/[/\\]/).filter(Boolean).at(-1) ?? null)
          : (draftProject?.name ?? null)
      }
      onProjectChange={handleProjectChange}
      onOpenContext={
        conversationId
          ? () => {
              setArtifactSelection({ conversationId, id: null });
              setPanelOpen(true);
            }
          : undefined
      }
    />
  );

  const empty = !conversationId && !live;
  const showBrowser = browserPanelOpen && !!activeBrowserSessionId;
  return (
    <MotionConfig reducedMotion="user">
      <div className="chat-workspace relative flex h-full min-w-0 overflow-hidden">
        {historyOpen ? (
          <button
            type="button"
            aria-label="关闭会话列表"
            className="absolute inset-0 z-20 bg-fg/20 lg:hidden"
            onClick={() => setHistoryOpen(false)}
          />
        ) : null}
        <div
          className={`${historyOpen ? "absolute inset-y-0 left-0 z-30 flex shadow-xl" : "hidden"} lg:flex lg:shadow-none`}
        >
          <ConversationList activeId={conversationId} />
          {historyOpen ? (
            <button
              type="button"
              aria-label="收起会话列表"
              onClick={() => setHistoryOpen(false)}
              className="absolute right-3 top-3 rounded-lg bg-surface p-2 text-muted lg:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <div className="chat-main flex min-w-0 flex-1 flex-col">
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
                <div className="chat-header flex min-h-[64px] items-center justify-between gap-3 border-b py-3 pl-4 pr-[4.5rem] sm:pl-6">
                  <button
                    type="button"
                    aria-label="打开会话列表"
                    title="会话列表"
                    onClick={() => setHistoryOpen(true)}
                    className="mr-2 rounded-md p-2 text-muted hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand lg:hidden"
                  >
                    <Menu className="h-4 w-4" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-[13px] font-semibold">
                      {workbench.data?.conversation.title ?? "对话"}
                    </h1>
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          pendingAction || pendingQuestion
                            ? "bg-warning"
                            : running
                              ? "bg-brand motion-safe:animate-pulse"
                              : "bg-success/70",
                        )}
                      />
                      {pendingAction || pendingQuestion
                        ? "等待你的确认"
                        : compacting || workbench.data?.activity === "compacting"
                          ? "正在整理上下文"
                          : running
                            ? "Agent 正在处理"
                            : "随时开始下一步"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 rounded-xl bg-surface-2/60 p-1">
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
                      aria-label="会话状态"
                      className={cn(
                        "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors",
                        panelOpen
                          ? "bg-surface text-brand shadow-sm"
                          : "text-muted hover:bg-surface hover:text-fg",
                      )}
                    >
                      <PanelRight className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">工作台</span>
                    </button>
                  </div>
                </div>
              )}
              <div
                ref={scroll.viewport}
                onScroll={scroll.onScroll}
                data-testid="chat-scroll"
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
              >
                <div
                  ref={scroll.content}
                  className="mx-auto flex max-w-[840px] flex-col gap-8 px-5 py-7 sm:px-9 sm:py-10"
                >
                  {(messages.data ?? []).map((m) =>
                    m.role === "user" ? (
                      <div key={m.id} className="flex justify-end">
                        <div className="chat-message-user max-w-[90%] whitespace-pre-wrap break-words px-4 py-3 text-[14px] leading-7 sm:max-w-[84%]">
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
                        <div className="chat-message-in flex justify-end">
                          <div className="chat-message-user max-w-[90%] whitespace-pre-wrap break-words px-4 py-3 text-[14px] leading-7 sm:max-w-[84%]">
                            {live.userMessage}
                          </div>
                        </div>
                      ) : null}
                      <div className="chat-message-in flex min-w-0 flex-col gap-2">
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
                        waiting={
                          pendingQuestion ? "question" : pendingAction ? "action" : undefined
                        }
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
                </div>
              </div>
              <div className="chat-dock relative mx-auto w-full max-w-[840px] px-4 pt-3 pb-3 sm:px-8 sm:pb-4">
                <AnimatePresence>
                  {scroll.away ? (
                    <motion.button
                      key="latest"
                      type="button"
                      onClick={() => scroll.toBottom()}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 6 }}
                      transition={{ duration: reduced ? 0 : 0.16 }}
                      className="absolute -top-10 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-elevated px-3 py-2 text-xs shadow-lg"
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                      回到最新消息
                    </motion.button>
                  ) : null}
                </AnimatePresence>
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
                {!automation && !pendingAction && !pendingQuestion ? (
                  <p className="mt-2 hidden text-center text-[10px] text-subtle sm:block">
                    Enter 发送 · Shift + Enter 换行
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>
        <AnimatePresence initial={false} mode="wait">
          {liveDocument && !showBrowser ? (
            <LiveDocumentPanel
              key="live-document"
              document={liveDocument}
              onClose={() => openArtifact(null)}
            />
          ) : livePresentation && !showBrowser ? (
            <LivePresentationPanel
              key="live-presentation"
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
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {conversationId &&
          panelOpen &&
          !showBrowser &&
          !selectedArtifact &&
          !liveDocument &&
          !livePresentation ? (
            <motion.div
              key="session-panel"
              initial={{ opacity: 0, x: reduced ? 0 : 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduced ? 0 : 24 }}
              transition={reduced ? { duration: 0 } : surfaceTransition}
              className="absolute inset-y-0 right-0 z-30 flex max-w-full bg-surface shadow-xl xl:static xl:shadow-none"
            >
              <SessionPanel
                key={conversationId}
                conversationId={conversationId}
                agent={agent}
                streaming={streaming}
                compacting={compacting}
                onCompacting={setCompacting}
                onClose={() => setPanelOpen(false)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {showBrowser ? (
            <motion.div
              key="browser"
              initial={{ opacity: 0, x: reduced ? 0 : 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: reduced ? 0 : 20 }}
              transition={reduced ? { duration: 0 } : surfaceTransition}
              className="absolute inset-y-0 right-0 z-30 max-w-full bg-surface shadow-xl xl:static xl:shadow-none"
            >
              <BrowserLivePanel
                sessionId={activeBrowserSessionId!}
                className="max-w-[calc(100vw-24px)]"
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
