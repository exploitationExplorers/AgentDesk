import type {
  AgentModelBinding,
  AgentStreamEvent,
  AiCommitJob,
  AiCommitPreview,
  AiCommitResult,
  AppSettings,
  Approval,
  ChatMessage,
  ClaudeSession,
  CommitInfo,
  Conversation,
  DailyDigest,
  DeployRecipe,
  DeployRecipeInput,
  DeployRun,
  FeedItem,
  GitAccount,
  HealthInfo,
  LaunchTarget,
  Project,
  Provider,
  ProviderCandidate,
  ProviderInput,
  RecipeStep,
  RemoteActivity,
  RemoteRepo,
  Server,
  ServerInput,
} from "@agentdesk/shared";
import type { Workflow, WorkflowInput, WorkflowRun } from "@agentdesk/workflow/dsl";
import { http, postStream } from "./http";

export interface SkillInfo {
  name: string;
  description: string;
  version: string;
  agents: string[];
  triggers: string[];
  dir: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  risk: string;
}

export interface RecipePreset {
  key: string;
  name: string;
  options: {
    remoteDir: string;
    branch?: string;
    buildCommand?: string;
    projectType: "node" | "java" | "go" | "python" | "php";
    projectName: string;
    healthUrl?: string;
  };
  steps: RecipeStep[];
}

export const api = {
  health: () => http.get<HealthInfo>("/health"),
  settings: () => http.get<AppSettings>("/settings"),
  updateSettings: (patch: Partial<AppSettings>) => http.put<AppSettings>("/settings", patch),
  approvals: (status?: "pending") => http.get<Approval[]>("/approvals", { status }),
  resolveApproval: (id: string, approved: boolean) =>
    http.post<Approval>(`/approvals/${id}`, { approved }),
  skills: () => http.get<SkillInfo[]>("/skills"),
  tools: () => http.get<ToolInfo[]>("/tools"),

  providers: () => http.get<Provider[]>("/providers"),
  createProvider: (input: ProviderInput) => http.post<Provider>("/providers", input),
  updateProvider: (id: string, input: Partial<ProviderInput>) =>
    http.put<Provider>(`/providers/${id}`, input),
  deleteProvider: (id: string) => http.delete(`/providers/${id}`),
  testProvider: (id: string) =>
    http.post<{ ok: boolean; latencyMs: number; reply?: string; error?: string }>(
      `/providers/${id}/test`,
    ),
  remoteModels: (id: string) => http.get<string[]>(`/providers/${id}/remote-models`),
  importCandidates: (source: "dotenv" | "cc-switch", path?: string) =>
    http.get<ProviderCandidate[]>("/providers/import/candidates", { source, path }),
  importProviders: (source: "dotenv" | "cc-switch", candidateIds: string[], path?: string) =>
    http.post<Provider[]>("/providers/import", { source, candidateIds, path }),
  bindings: () => http.get<AgentModelBinding[]>("/agent-bindings"),
  setBindings: (bindings: AgentModelBinding[]) =>
    http.put<AgentModelBinding[]>("/agent-bindings", bindings),

  projects: () => http.get<Project[]>("/projects"),
  scanProjects: () => http.post<{ found: number; removed: number }>("/projects/scan"),
  addProject: (path: string) => http.post<Project>("/projects", { path }),
  listRemoteRepos: (platform: "github" | "gitee" | "gitlab") =>
    http.get<RemoteRepo[]>("/projects/remote", { platform }),
  importRemoteRepo: (input: {
    platform: "github" | "gitee" | "gitlab";
    cloneUrl: string;
    fullName?: string;
  }) => http.post<Project>("/projects/import-remote", input),
  patchProject: (id: string, patch: { pinned?: boolean; tags?: string[] }) =>
    http.patch<Project>(`/projects/${id}`, patch),
  removeProject: (id: string) => http.delete(`/projects/${id}`),
  refreshProject: (id: string) => http.post<Project>(`/projects/${id}/refresh`),
  projectActivity: (id: string) => http.get<RemoteActivity[]>(`/projects/${id}/activity`),
  projectCommits: (id: string) => http.get<CommitInfo[]>(`/projects/${id}/commits`),
  pullProject: (id: string) => http.post<{ output: string }>(`/projects/${id}/pull`),
  aiCommitPreview: (id: string) => http.post<AiCommitPreview>(`/projects/${id}/ai-commit/preview`),
  aiCommitStart: (id: string, body: { message: string; stageAll?: boolean; push?: boolean }) =>
    http.post<{ jobId: string }>(`/projects/${id}/ai-commit`, body),
  aiCommitJob: (id: string, jobId: string) =>
    http.get<AiCommitJob>(`/projects/${id}/ai-commit/jobs/${jobId}`),
  /** 启动异步提交并轮询直到完成（避免 husky 触发 sidecar 热重载导致 Failed to fetch） */
  aiCommit: async (
    id: string,
    body: { message: string; stageAll?: boolean; push?: boolean },
  ): Promise<AiCommitResult> => {
    const { jobId } = await http.post<{ jobId: string }>(`/projects/${id}/ai-commit`, body);
    const started = Date.now();
    for (;;) {
      if (Date.now() - started > 5 * 60_000) throw new Error("提交超时：请查看终端 husky/git 输出");
      await new Promise((r) => setTimeout(r, 800));
      try {
        const job = await http.get<AiCommitJob>(`/projects/${id}/ai-commit/jobs/${jobId}`);
        if (job.status === "done" && job.result) return job.result;
        if (job.status === "error") throw new Error(job.error ?? "提交失败");
      } catch (error) {
        // sidecar 热重载时会出现 Failed to fetch；独立 worker 仍在跑，继续轮询即可
        const msg = error instanceof Error ? error.message : String(error);
        const transient =
          /fetch|network|ECONNREFUSED|Failed to fetch|Load failed|\b502\b|\b503\b|\b504\b/i.test(
            msg,
          );
        if (!transient) throw error;
      }
    }
  },
  launchProject: (id: string, target: LaunchTarget) =>
    http.post<Project>(`/projects/${id}/launch`, { target }),
  claudeSessions: (projectId?: string) =>
    http.get<ClaudeSession[]>("/claude/sessions", { projectId }),
  gitAccounts: () => http.get<GitAccount[]>("/git-accounts"),
  saveGitAccount: (input: { platform: GitAccount["platform"]; host?: string; token?: string }) =>
    http.put<GitAccount>("/git-accounts", input),
  deleteGitAccount: (id: string) => http.delete(`/git-accounts/${encodeURIComponent(id)}`),

  feed: (query: { date?: string; source?: string; tag?: string; favorite?: string; q?: string }) =>
    http.get<FeedItem[]>("/feed", query),
  feedDates: () => http.get<string[]>("/feed/dates"),
  refreshFeed: () =>
    http.post<{ date: string; fetched: number; summarized: number; errors: string[] }>(
      "/feed/refresh",
    ),
  toggleFavorite: (id: string) => http.post<FeedItem>(`/feed/${encodeURIComponent(id)}/favorite`),
  digest: (date?: string) => http.get<DailyDigest | null>("/feed/digest", { date }),
  generateDigest: (date?: string) => http.post<DailyDigest>("/feed/digest", { date }),

  servers: () => http.get<Server[]>("/servers"),
  saveServer: (input: ServerInput, id?: string) =>
    id ? http.put<Server>(`/servers/${id}`, input) : http.post<Server>("/servers", input),
  deleteServer: (id: string) => http.delete(`/servers/${id}`),
  openServerPanel: (id: string) => http.post(`/servers/${id}/open`),
  recipes: () => http.get<DeployRecipe[]>("/recipes"),
  recipePresets: () => http.get<RecipePreset[]>("/recipes/presets"),
  presetSteps: (options: RecipePreset["options"]) =>
    http.post<RecipeStep[]>("/recipes/preset-steps", options),
  saveRecipe: (input: DeployRecipeInput, id?: string) =>
    id
      ? http.put<DeployRecipe>(`/recipes/${id}`, input)
      : http.post<DeployRecipe>("/recipes", input),
  deleteRecipe: (id: string) => http.delete(`/recipes/${id}`),
  runRecipe: (id: string) => http.post<DeployRun>(`/recipes/${id}/run`),
  deployRuns: (recipeId?: string) => http.get<DeployRun[]>("/deploy/runs", { recipeId }),
  deployRun: (id: string) => http.get<DeployRun>(`/deploy/runs/${id}`),
  retryDeploy: (id: string) => http.post<DeployRun>(`/deploy/runs/${id}/retry`),
  cancelDeploy: (id: string) => http.post<DeployRun>(`/deploy/runs/${id}/cancel`),

  conversations: () => http.get<Conversation[]>("/conversations"),
  messages: (id: string) => http.get<ChatMessage[]>(`/conversations/${id}/messages`),
  deleteConversation: (id: string) => http.delete(`/conversations/${id}`),
  chat: (
    body: { conversationId?: string; message: string; agent?: string },
    onEvent: (e: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ) => postStream<AgentStreamEvent>("/chat", body, onEvent, signal),

  workflows: () => http.get<Workflow[]>("/workflows"),
  workflow: (id: string) => http.get<Workflow>(`/workflows/${id}`),
  workflowTemplates: () =>
    http.get<Array<{ key: string; name: string; description: string }>>("/workflow-templates"),
  createWorkflowFromTemplate: (key: string) =>
    http.post<Workflow>("/workflows/from-template", { key }),
  saveWorkflow: (input: WorkflowInput, id?: string) =>
    id ? http.put<Workflow>(`/workflows/${id}`, input) : http.post<Workflow>("/workflows", input),
  deleteWorkflow: (id: string) => http.delete(`/workflows/${id}`),
  runWorkflow: (id: string, inputs: Record<string, string>) =>
    http.post<WorkflowRun>(`/workflows/${id}/run`, { inputs }),
  workflowRuns: (workflowId?: string) => http.get<WorkflowRun[]>("/workflow-runs", { workflowId }),
  workflowRun: (id: string) => http.get<WorkflowRun>(`/workflow-runs/${id}`),
  cancelWorkflowRun: (id: string) => http.post(`/workflow-runs/${id}/cancel`),
};
