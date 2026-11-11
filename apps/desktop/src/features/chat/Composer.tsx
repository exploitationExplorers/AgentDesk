import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowUp,
  Brain,
  FolderGit2,
  Loader2,
  Settings2,
  Square,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  AgentName,
  ConversationContextStatus,
  ModelSelection,
  Project,
  ReasoningEffort,
} from "@agentdesk/shared";
import {
  Button,
  ChoiceMenu,
  DeepAgentComposer,
  GlassFolder,
  GlassSurface,
  ReasoningEffortSlider,
  THINKING_DEPTH_TO_EFFORT,
  effortToThinkingDepth,
  type ThinkingDepth,
  cn,
} from "@agentdesk/ui";
import { ModelBrandIcon } from "../../components/ModelBrandIcon";
import { AGENT_META } from "../../lib/agents";
import { api, type SkillInfo } from "../../lib/api";
import { toast } from "../../lib/toast";
import { AnchoredPortal } from "./AnchoredPortal";
import { applyMentionAt, filterMentionSkills, mentionQueryAt } from "./mentions";
import { SkillMentionMenu } from "./SkillMentionMenu";
import { EMPTY_CHAT_DRAFT, useChatDrafts } from "./drafts";
import { usePromptOptimization } from "./usePromptOptimization";
import { PromptOptimizationPreview } from "./PromptOptimizationPreview";

const EFFORT_STORAGE_KEY = "agentdesk.composer.reasoningEffort";

function readStoredEffort(): ReasoningEffort {
  try {
    const raw = localStorage.getItem(EFFORT_STORAGE_KEY);
    if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh")
      return raw;
  } catch {
    /* ignore */
  }
  return "medium";
}

const AGENT_ORDER: AgentName[] = ["orchestrator", "project", "deploy", "research", "code"];

export type ComposerProject = Pick<Project, "id" | "name" | "path">;

function ProjectFolderPicker({
  projectId,
  projectName,
  onProjectChange,
  disabled,
}: {
  projectId?: string | null;
  projectName?: string | null;
  onProjectChange?: (project: ComposerProject | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [droppingId, setDroppingId] = useState<string | null>(null);
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const selected = projects.data?.find((project) => project.id === projectId);
  const label = selected?.name ?? projectName ?? null;
  const close = (restoreFocus = false) => {
    setMenuOpen(false);
    setFolderOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  const importLocal = useMutation({
    mutationFn: async () => {
      const picked = await api.pickProjectDirectory();
      if (!picked.path) return null;
      return api.addProject(picked.path);
    },
    onSuccess: (project) => {
      if (!project) return;
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onProjectChange?.({ id: project.id, name: project.name, path: project.path });
      setDroppingId(project.id);
      setFolderOpen(true);
      toast("已导入并关联项目", { description: project.path, tone: "success" });
      window.setTimeout(() => setDroppingId(null), 1000);
    },
    onError: (error: Error) => toast(error.message || "导入失败", { tone: "danger" }),
  });

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || portalRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  if (!onProjectChange) return null;

  return (
    <div ref={root} className="relative min-w-0">
      <div
        className={cn(
          "flex h-9 min-w-0 max-w-[180px] items-center rounded-xl transition-colors",
          label ? "bg-brand/6 text-brand" : "text-muted",
          disabled && "opacity-50",
        )}
      >
        <button
          ref={trigger}
          type="button"
          aria-label="关联项目"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? id : undefined}
          disabled={disabled}
          title={label ? `当前项目：${label}` : "关联项目目录"}
          onClick={() => (menuOpen ? close() : setMenuOpen(true))}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-xl py-0 pl-2.5 text-xs font-medium hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-brand disabled:pointer-events-none",
            label ? "pr-1" : "pr-2.5",
          )}
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label ?? "关联项目"}</span>
        </button>
        {label ? (
          <button
            type="button"
            aria-label="取消关联项目"
            title="取消关联项目"
            disabled={disabled}
            className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-lg text-brand/70 hover:bg-surface-2 hover:text-brand focus-visible:outline-2 focus-visible:outline-brand disabled:pointer-events-none"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onProjectChange(null);
              close();
            }}
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <AnchoredPortal open={menuOpen} anchorRef={root} width={360} gap={12} clip={false}>
        <div ref={portalRef}>
          <GlassSurface
            elevated
            id={id}
            role="dialog"
            aria-label="选择关联项目"
            className="lb-popover w-full origin-bottom-left overflow-visible rounded-2xl p-3"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close(true);
              }
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <p className="text-[11px] font-medium text-subtle">选择项目关联当前对话</p>
              {projectId ? (
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-fg"
                  onClick={() => {
                    onProjectChange(null);
                    close(true);
                  }}
                >
                  <X className="h-3 w-3" />
                  清除
                </button>
              ) : null}
            </div>
            <div
              className={`flex justify-center overflow-visible pb-2 ${folderOpen ? "pt-24" : "pt-3"}`}
            >
              <GlassFolder
                label="Projects"
                scale={0.72}
                open={folderOpen}
                onOpenChange={setFolderOpen}
                selectedId={projectId}
                droppingId={droppingId}
                action="more"
                menuItems={[
                  {
                    id: "toggle",
                    label: folderOpen ? "收起项目" : "展开项目",
                    onSelect: () => setFolderOpen((value) => !value),
                  },
                  {
                    id: "import",
                    label: importLocal.isPending ? "正在选择目录…" : "导入本地目录",
                    onSelect: () => {
                      if (!importLocal.isPending) importLocal.mutate();
                    },
                  },
                ]}
                items={(projects.data ?? []).map((project) => ({
                  id: project.id,
                  name: project.name,
                  meta: project.branch ?? project.platform,
                }))}
                emptyText={projects.isLoading ? "正在加载项目…" : "暂无登记项目"}
                onSelect={(nextId) => {
                  const project = projects.data?.find((item) => item.id === nextId);
                  if (!project) return;
                  onProjectChange({ id: project.id, name: project.name, path: project.path });
                  close(true);
                }}
              />
            </div>
          </GlassSurface>
        </div>
      </AnchoredPortal>
    </div>
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
  context,
  onOpenContext,
  projectId,
  projectName,
  onProjectChange,
  draftScopeId,
}: {
  onSend: (text: string, options?: { modelSelection?: ModelSelection }) => void;
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
  projectId?: string | null;
  projectName?: string | null;
  onProjectChange?: (project: ComposerProject | null) => void;
  draftScopeId?: string;
}) {
  const localScopeId = useId();
  const scopeId = draftScopeId ?? `composer:${localScopeId}`;
  const draft = useChatDrafts((state) => state.drafts[scopeId] ?? EMPTY_CHAT_DRAFT);
  const text = draft.text;
  const setText = (value: string) => useChatDrafts.getState().setText(scopeId, value);
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [effort, setEffort] = useState<ReasoningEffort>(() => readStoredEffort());
  const [effortOpen, setEffortOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const effortRoot = useRef<HTMLDivElement>(null);
  const effortPortal = useRef<HTMLDivElement>(null);
  const effortTrigger = useRef<HTMLButtonElement>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const bindings = useQuery({ queryKey: ["bindings"], queryFn: api.bindings });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const skills = useQuery({ queryKey: ["skills"], queryFn: api.skills });
  const own = bindings.data?.find((item) => item.agent === agent);
  const binding = own?.model ? own : bindings.data?.find((item) => item.agent === "orchestrator");
  const model = context?.model ?? binding?.model;
  const providerId = context?.providerId ?? binding?.providerId;
  const provider = providers.data?.find((item) => item.id === providerId);
  const selection: ModelSelection | undefined =
    model && provider?.enabled && provider.hasKey
      ? { providerId: provider.id, model, reasoningEffort: effort }
      : undefined;
  const optimization = usePromptOptimization({
    scopeId,
    projectId,
    agent,
    modelSelection: selection,
    unavailable: streaming || disabled,
  });
  const thinkingDepth = effortToThinkingDepth(effort);
  const effortLabel =
    thinkingDepth === "simple" ? "轻量" : thinkingDepth === "deep" ? "深入" : "标准";
  const percent = context
    ? Math.min(
        100,
        Math.round((context.estimatedInputTokens / Math.max(1, context.inputBudgetTokens)) * 100),
      )
    : null;
  const activeMention = mentionDismissed ? null : mentionQueryAt(text, caret);
  const mentionItems = useMemo(
    () => (activeMention ? filterMentionSkills(skills.data ?? [], activeMention.query, agent) : []),
    [activeMention, skills.data, agent],
  );
  const mentionOpen = Boolean(activeMention) && mentionItems.length > 0 && !streaming && !disabled;

  useEffect(() => {
    if (initial) useChatDrafts.getState().setText(scopeId, initial);
  }, [initial, scopeId]);

  useEffect(() => {
    setCaret(0);
    setMentionDismissed(true);
  }, [scopeId]);

  useEffect(() => {
    setMentionIndex(0);
  }, [activeMention?.query, mentionItems.length]);

  useEffect(() => {
    try {
      localStorage.setItem(EFFORT_STORAGE_KEY, effort);
    } catch {
      /* ignore */
    }
  }, [effort]);

  useEffect(() => {
    if (!effortOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (effortRoot.current?.contains(target) || effortPortal.current?.contains(target)) return;
      setEffortOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEffortOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [effortOpen]);

  useEffect(() => {
    if (disabled || streaming) setEffortOpen(false);
  }, [disabled, streaming]);

  const syncCaret = () => {
    const element = ref.current;
    if (!element) return;
    setCaret(element.selectionStart);
  };

  const insertSkill = (skill: SkillInfo) => {
    if (!activeMention) return;
    const next = applyMentionAt(text, activeMention.start, activeMention.end, skill.name);
    setText(next.value);
    setCaret(next.caret);
    setMentionDismissed(false);
    requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
      setCaret(element.selectionStart);
    });
  };

  const buildSelection = (): ModelSelection | undefined => {
    if (!providerId || !model) return undefined;
    return { providerId, model, reasoningEffort: effort };
  };

  const setThinkingDepth = (depth: ThinkingDepth) => {
    setEffort(THINKING_DEPTH_TO_EFFORT[depth]);
  };

  const submit = () => {
    if (mentionOpen) {
      const skill = mentionItems[mentionIndex] ?? mentionItems[0];
      if (skill) insertSkill(skill);
      return;
    }
    const value = text.trim();
    if (!value || streaming || disabled) return;
    const modelSelection = buildSelection();
    optimization.cancel();
    onSend(value, modelSelection ? { modelSelection } : undefined);
    setText("");
    setCaret(0);
    setMentionDismissed(false);
    setEffortOpen(false);
    ref.current?.focus();
  };

  return (
    <div ref={shellRef} className="relative">
      <AnchoredPortal open={mentionOpen} anchorRef={shellRef} width={352} gap={14}>
        <SkillMentionMenu
          items={mentionItems}
          index={Math.min(mentionIndex, mentionItems.length - 1)}
          query={activeMention?.query ?? ""}
          onHover={setMentionIndex}
          onSelect={insertSkill}
          onClose={() => setMentionDismissed(true)}
        />
      </AnchoredPortal>
      <DeepAgentComposer
        value={text}
        onValueChange={(value) => {
          setText(value);
          setMentionDismissed(false);
          requestAnimationFrame(syncCaret);
        }}
        onSubmit={submit}
        onSelect={syncCaret}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        onKeyDown={(event) => {
          if (!mentionOpen) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setMentionIndex((index) => (index + 1) % mentionItems.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setMentionIndex((index) => (index - 1 + mentionItems.length) % mentionItems.length);
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            const skill = mentionItems[mentionIndex] ?? mentionItems[0];
            if (skill) insertSkill(skill);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setMentionDismissed(true);
          }
        }}
        inputRef={ref}
        autoFocus={autoFocus}
        large={large}
        disabled={disabled}
        aria-label="发送消息"
        aria-autocomplete="list"
        aria-expanded={mentionOpen}
        placeholder={
          streaming ? "任务进行中，可先写下接下来的想法…" : "描述你的想法，或输入 @ 选择技能。"
        }
        toolbar={
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
              onChange={(value) => {
                optimization.cancel();
                onAgentChange?.(value);
              }}
              disabled={!onAgentChange || streaming || disabled}
              className="shrink-0 bg-brand/6 text-brand"
            />
            <ProjectFolderPicker
              projectId={projectId}
              projectName={projectName}
              onProjectChange={
                onProjectChange
                  ? (project) => {
                      optimization.cancel();
                      onProjectChange(project);
                    }
                  : undefined
              }
              disabled={streaming || disabled || !onProjectChange}
            />
            <button
              type="button"
              aria-label="优化提示词"
              title={
                optimization.state?.status === "pending"
                  ? "正在优化，可继续编辑草稿"
                  : "优化当前草稿，预览后应用；会产生一次模型请求"
              }
              disabled={
                !text.trim() || streaming || disabled || optimization.state?.status === "pending"
              }
              onClick={() => {
                if (optimization.state?.status === "ready") optimization.setPreviewOpen(true);
                else void optimization.start();
              }}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-2 text-[11px] text-brand transition-colors hover:bg-brand/8 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-40"
            >
              {optimization.state?.status === "pending" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <WandSparkles className="h-3.5 w-3.5" />
              )}
              <span className="hidden lg:inline">优化提示词</span>
            </button>
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
            <div ref={effortRoot} className="relative flex min-w-0 items-center">
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
                <span className="hidden max-w-[160px] truncate sm:inline">
                  {model ?? "配置模型"}
                </span>
              </Link>
              <button
                ref={effortTrigger}
                type="button"
                aria-label={`思考强度：${effortLabel}`}
                aria-haspopup="dialog"
                aria-expanded={effortOpen}
                title={`思考强度：${effortLabel}`}
                disabled={streaming || disabled || !providerId || !model}
                onClick={() => setEffortOpen((open) => !open)}
                className={cn(
                  "ml-0.5 flex h-9 items-center gap-1 rounded-xl px-2 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-brand",
                  effortOpen || thinkingDepth !== "medium"
                    ? "bg-brand/10 text-brand"
                    : "text-muted hover:bg-surface-2 hover:text-fg",
                  (streaming || disabled || !providerId || !model) && "opacity-50",
                )}
              >
                <Brain className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">{effortLabel}</span>
              </button>
              <AnchoredPortal open={effortOpen} anchorRef={effortTrigger} width={220} gap={10}>
                <div
                  ref={effortPortal}
                  className="lb-popover rounded-2xl border border-border/70 bg-surface/95 p-3 shadow-[0_18px_48px_-20px_rgba(15,23,42,0.55)] backdrop-blur-md"
                >
                  <ReasoningEffortSlider
                    value={thinkingDepth}
                    onValueChange={setThinkingDepth}
                    disabled={streaming || disabled}
                  />
                </div>
              </AnchoredPortal>
            </div>
          </div>
        }
        action={
          <>
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
            <Button
              type="button"
              variant={streaming ? "secondary" : "brand"}
              size="icon"
              onClick={streaming ? onStop : submit}
              disabled={!streaming && (!text.trim() || disabled)}
              aria-label={streaming ? "停止" : "发送"}
              className="lb-composer-send h-9 w-9"
            >
              {streaming ? (
                <Square className="h-3 w-3 fill-current" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </Button>
          </>
        }
      />
      {optimization.state ? (
        <div
          className="mt-2 flex flex-wrap items-center justify-between gap-2 px-2 text-xs"
          aria-live="polite"
        >
          {optimization.state.status === "pending" ? (
            <>
              <span role="status" className="flex items-center gap-2 text-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                正在优化，可继续编辑草稿…
              </span>
              <button
                type="button"
                onClick={optimization.cancel}
                className="rounded px-2 py-1 text-muted hover:text-fg"
              >
                取消优化
              </button>
            </>
          ) : optimization.state.status === "error" ? (
            <>
              <p role="alert" className="min-w-0 flex-1 break-words text-danger">
                {optimization.state.message}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void optimization.start()}
                  className="rounded px-2 py-1 text-brand"
                >
                  重试优化
                </button>
                <button
                  type="button"
                  onClick={optimization.cancel}
                  aria-label="关闭优化提示"
                  className="rounded p-1 text-muted"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          ) : (
            <>
              <span role="status" className="text-muted">
                {optimization.canApply
                  ? "提示词已优化，检查后应用。"
                  : "草稿已修改，优化结果仅供参考。"}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => optimization.setPreviewOpen(true)}
                  className="rounded px-2 py-1 text-brand"
                >
                  查看优化结果
                </button>
                <button
                  type="button"
                  onClick={optimization.cancel}
                  aria-label="放弃优化结果"
                  className="rounded p-1 text-muted"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
      {optimization.state?.status === "ready" ? (
        <PromptOptimizationPreview
          key={optimization.state.snapshot.requestId}
          state={optimization.state}
          open={optimization.previewOpen}
          canApply={optimization.canApply}
          onClose={() => {
            optimization.setPreviewOpen(false);
            ref.current?.focus();
          }}
          onApply={() => {
            if (optimization.apply()) requestAnimationFrame(() => ref.current?.focus());
          }}
          onRetry={() => void optimization.start()}
        />
      ) : null}
    </div>
  );
}
