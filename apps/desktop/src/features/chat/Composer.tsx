import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUp, FolderGit2, FolderPlus, Settings2, Square, Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentName, ConversationContextStatus, Project } from "@agentdesk/shared";
import {
  Button,
  ChoiceMenu,
  DeepAgentComposer,
  GlassFolder,
  GlassSurface,
  Input,
  cn,
} from "@agentdesk/ui";
import { ModelBrandIcon } from "../../components/ModelBrandIcon";
import { AGENT_META } from "../../lib/agents";
import { api } from "../../lib/api";
import { toast } from "../../lib/toast";

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
  const trigger = useRef<HTMLButtonElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(true);
  const [importPath, setImportPath] = useState("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const selected = projects.data?.find((project) => project.id === projectId);
  const label = selected?.name ?? projectName ?? null;
  const close = (restoreFocus = false) => {
    setMenuOpen(false);
    setFolderOpen(true);
    setImportPath("");
    if (restoreFocus) trigger.current?.focus();
  };
  const importLocal = useMutation({
    mutationFn: () => api.addProject(importPath.trim()),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onProjectChange?.({ id: project.id, name: project.name, path: project.path });
      toast("已导入并关联项目", { description: project.path, tone: "success" });
      close(true);
    },
    onError: (error: Error) => toast(error.message || "导入失败", { tone: "danger" }),
  });

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  if (!onProjectChange) return null;

  return (
    <div
      ref={root}
      className="relative min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
    >
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
      {menuOpen ? (
        <GlassSurface
          elevated
          id={id}
          role="dialog"
          aria-label="选择关联项目"
          className="lb-popover absolute bottom-[calc(100%+12px)] left-0 z-40 w-[min(360px,calc(100vw-32px))] origin-bottom-left rounded-2xl p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            }
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <p className="text-[11px] font-medium text-subtle">展开文件夹并点选项目</p>
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
          <div className="flex justify-center overflow-hidden pb-1 pt-2">
            <GlassFolder
              label="Projects"
              open={folderOpen}
              onOpenChange={setFolderOpen}
              selectedId={projectId}
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
          <div className="mt-3 border-t border-border/60 pt-3">
            <p className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-medium text-subtle">
              <FolderPlus className="h-3.5 w-3.5" />
              导入本机其他目录
            </p>
            <div className="flex gap-2">
              <Input
                ref={pathInput}
                aria-label="本地仓库路径"
                value={importPath}
                onChange={(event) => setImportPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && importPath.trim() && !importLocal.isPending) {
                    event.preventDefault();
                    importLocal.mutate();
                  }
                }}
                placeholder="例如 D:\projects\my-app"
                className="h-9 min-w-0 flex-1 font-mono text-[11px]"
              />
              <Button
                type="button"
                size="sm"
                variant="primary"
                className="h-9 shrink-0"
                disabled={!importPath.trim()}
                loading={importLocal.isPending}
                onClick={() => importLocal.mutate()}
              >
                导入并关联
              </Button>
            </div>
            <p className="mt-1.5 px-1 text-[10.5px] leading-4 text-subtle">
              填写任意盘符下的本地 Git 仓库路径，登记后会立刻关联到当前对话。
            </p>
          </div>
        </GlassSurface>
      ) : null}
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
  projectId?: string | null;
  projectName?: string | null;
  onProjectChange?: (project: ComposerProject | null) => void;
}) {
  const [text, setText] = useState(initial ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
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

  const submit = () => {
    const value = text.trim();
    if (!value || streaming || disabled) return;
    onSend(value);
    setText("");
    ref.current?.focus();
  };

  return (
    <DeepAgentComposer
      value={text}
      onValueChange={setText}
      onSubmit={submit}
      inputRef={ref}
      autoFocus={autoFocus}
      large={large}
      disabled={disabled}
      aria-label="发送消息"
      placeholder={
        streaming ? "任务进行中，可先写下接下来的想法…" : "描述你的想法，让 Agent 帮你完成。"
      }
      toolbar={
        <>
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
          <ProjectFolderPicker
            projectId={projectId}
            projectName={projectName}
            onProjectChange={onProjectChange}
            disabled={streaming || disabled || !onProjectChange}
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
        </>
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
  );
}
