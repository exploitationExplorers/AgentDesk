import type {
  AgentModelBinding,
  AgentStreamEvent,
  AiCommitJob,
  AiCommitPreview,
  AiCommitResult,
  AppSettings,
  Approval,
  AutomationBinding,
  AutomationBindingInput,
  AutomationCard,
  AutoloopInteractionAnswer,
  AutoloopStatus,
  ChatMessage,
  ClaudeSession,
  CommitInfo,
  Conversation,
  DailyDigest,
  DiskCleanResult,
  DiskScan,
  DiskStatus,
  DeployRecipe,
  DeployRecipeInput,
  DeployRun,
  FeedItem,
  GitAccount,
  GradeResult,
  HealthInfo,
  ImportSourceInput,
  LaunchTarget,
  LearningActivity,
  LearningPlan,
  LearningPlanInput,
  LearningProfile,
  LearningProfileInput,
  LearningSource,
  LearningToday,
  Memory,
  Project,
  Provider,
  ProviderCandidate,
  ProviderInput,
  RecipeStep,
  ReachCapabilities,
  ReachRequestInput,
  ReachResult,
  ReachSettings,
  ReachStatus,
  RemoteActivity,
  RemoteRepo,
  BrowserSessionState,
  Server,
  ServerInput,
  KnowledgeUnit,
  ReviewQueue,
  ReviewRating,
  SkillSuggestionResult,
  StarredRepo,
  Task,
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
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}

export interface WechatGroup {
  username: string;
  displayName: string;
  nickName: string;
  remark: string;
  messageCount: number;
}

export interface WechatSkillStatus {
  skillDir: string;
  decryptedReady: boolean;
  decryptedDir: string;
  pythonOk: boolean;
  python?: string;
  message: string;
}

export interface WechatReportJob {
  id: string;
  chatroom: string;
  date: string;
  status: "queued" | "analyzing" | "writing" | "rendering" | "succeeded" | "failed";
  logs: string[];
  error?: string;
  reportFile?: string;
  createdAt: string;
  updatedAt: string;
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

export interface DocsChapter {
  title: string;
  url: string | null;
  children: DocsChapter[];
}

export interface ArticleHeading {
  id: string;
  level: number;
  text: string;
}

export interface ArticleCodeTab {
  label: string;
  lang: string;
  code: string;
}

export type ArticleBlock =
  | { kind: "prose"; text: string; headings: ArticleHeading[] }
  | { kind: "code"; tabs: ArticleCodeTab[] };

export const api = {
  autoloopStatus: () => http.get<AutoloopStatus>("/autoloop/status"),
  automations: () => http.get<AutomationBinding[]>("/automations"),
  createAutomation: (input: AutomationBindingInput) =>
    http.post<AutomationBinding>("/automations", input),
  disableAutomation: (id: string) =>
    http.post<AutomationBinding>(`/automations/${encodeURIComponent(id)}/disable`),
  triggerAutomation: (id: string, eventId: string) =>
    http.post<{ commandId: string; taskId?: string; conversationId?: string }>(
      `/automations/${encodeURIComponent(id)}/trigger`,
      { eventId },
    ),
  automationTasks: (id: string) => http.get<Task[]>(`/automations/${encodeURIComponent(id)}/tasks`),
  interactions: (taskId: string) => http.get<AutomationCard[]>("/interactions", { taskId }),
  answerInteraction: (id: string, answer: AutoloopInteractionAnswer) =>
    http.post<AutomationCard>(`/interactions/${encodeURIComponent(id)}/answer`, answer),
  cancelAutomationTask: (id: string) =>
    http.post<{ requested: boolean }>(`/automation-tasks/${encodeURIComponent(id)}/cancel`),
  followupAutomationTask: (id: string, input: { message: string; eventId: string }) =>
    http.post<{ commandId: string }>(`/automation-tasks/${encodeURIComponent(id)}/followup`, input),
  resumeAutomationTask: (id: string) =>
    http.post<{ requested: boolean }>(`/automation-tasks/${encodeURIComponent(id)}/resume`, {}),
  health: () => http.get<HealthInfo>("/health"),
  settings: () => http.get<AppSettings>("/settings"),
  updateSettings: (patch: Partial<AppSettings>) => http.put<AppSettings>("/settings", patch),
  approvals: (status?: "pending") => http.get<Approval[]>("/approvals", { status }),
  resolveApproval: (id: string, approved: boolean) =>
    http.post<Approval>(`/approvals/${id}`, { approved }),
  skills: () => http.get<SkillInfo[]>("/skills"),
  wechatStatus: () => http.get<WechatSkillStatus>("/skills/wechat/status"),
  wechatDecrypt: () => http.post<{ ok: true; message: string }>("/skills/wechat/decrypt"),
  wechatGroups: () => http.get<WechatGroup[]>("/skills/wechat/groups"),
  wechatReports: () => http.get<WechatReportJob[]>("/skills/wechat/reports"),
  wechatReport: (id: string) => http.get<WechatReportJob>(`/skills/wechat/reports/${id}`),
  startWechatReport: (body: { chatroom: string; date?: string }) =>
    http.post<WechatReportJob>("/skills/wechat/reports", body),
  tools: () => http.get<ToolInfo[]>("/tools"),
  reachCapabilities: () => http.get<ReachCapabilities>("/reach/capabilities"),
  reachStatus: () => http.get<ReachStatus>("/reach/status"),
  reachSettings: () => http.get<ReachSettings>("/reach/settings"),
  updateReachSettings: (settings: ReachSettings) =>
    http.put<ReachSettings>("/reach/settings", settings),
  runReach: (input: ReachRequestInput) => http.post<ReachResult>("/reach/run", input),
  memories: () => http.get<Memory[]>("/memories"),
  deleteMemory: (id: string) =>
    http.delete<{ id: string; deleted: true }>(`/memories/${encodeURIComponent(id)}`),
  diskStatus: () => http.get<DiskStatus>("/disk/status"),
  diskScan: () => http.get<DiskScan | null>("/disk/scan"),
  scanDisk: (volumePath?: string) => http.post<DiskScan>("/disk/scan", { volumePath }),
  reviewDisk: (scanId: string) => http.post<DiskScan>("/disk/review", { scanId }),
  cleanDisk: (scanId: string, ids: string[]) =>
    http.post<DiskCleanResult>("/disk/clean", { scanId, ids }),
  revealDisk: (scanId: string, id: string) =>
    http.post<{ ok: true }>("/disk/reveal", { scanId, id }),

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
  refreshProjectStars: () =>
    http.post<{ updated: number; gained: number }>("/projects/refresh-stars"),
  addProject: (path: string) => http.post<Project>("/projects", { path }),
  pickProjectDirectory: () => http.post<{ path: string | null }>("/projects/pick-directory"),
  listRemoteRepos: (platform: "github" | "gitee" | "gitlab") =>
    http.get<RemoteRepo[]>("/projects/remote", { platform }),
  starredRepos: () => http.get<StarredRepo[]>("/projects/starred"),
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
    body: {
      conversationId?: string;
      message: string;
      agent?: string;
      workspace?: string;
      modelSelection?: { providerId: string; model: string; reasoningEffort?: string };
    },
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

  browserSessions: () => http.get<BrowserSessionState[]>("/browser/sessions"),
  browserSession: (id: string) =>
    http.get<BrowserSessionState>(`/browser/sessions/${encodeURIComponent(id)}`),
  browserOpen: (body: { sessionId?: string; url?: string; headless?: boolean }) =>
    http.post<BrowserSessionState>("/browser/sessions", body),
  browserReveal: (id: string) =>
    http.post<BrowserSessionState>(`/browser/sessions/${encodeURIComponent(id)}/reveal`),
  browserClose: (id: string) => http.delete(`/browser/sessions/${encodeURIComponent(id)}`),

  learningToday: (date?: string) => http.get<LearningToday>("/learning/today", { date }),
  learningProfiles: () => http.get<LearningProfile[]>("/learning/profiles"),
  createLearningProfile: (input: LearningProfileInput) =>
    http.post<LearningProfile>("/learning/profiles", input),
  suggestSkills: (profession: string, targetRole?: string | null) =>
    http.post<SkillSuggestionResult>("/learning/skill-suggestions", { profession, targetRole }),
  learningPlans: (profileId?: string) => http.get<LearningPlan[]>("/learning/plans", { profileId }),
  createLearningPlan: (input: LearningPlanInput) =>
    http.post<LearningPlan>("/learning/plans", input),
  setActivityStatus: (id: string, status: "pending" | "done" | "skipped") =>
    http.post<LearningActivity>(`/learning/activities/${id}/status`, { status }),

  learningOutline: (url: string) => http.get<DocsChapter[]>("/learning/outline", { url }),
  learningPage: (url: string) =>
    http.get<{ url: string; blocks: ArticleBlock[] }>("/learning/page", { url }),
  learningSources: () => http.get<LearningSource[]>("/learning/sources"),
  importSource: (input: ImportSourceInput) => http.post<LearningSource>("/learning/sources", input),
  sourceUnits: (id: string) => http.get<KnowledgeUnit[]>(`/learning/sources/${id}/units`),
  deleteSource: (id: string) => http.delete(`/learning/sources/${id}`),
  reviewQueue: (date?: string) => http.get<ReviewQueue>("/learning/review", { date }),
  gradeReview: (id: string, rating: ReviewRating) =>
    http.post<GradeResult>(`/learning/review/${id}/grade`, { rating }),
};
