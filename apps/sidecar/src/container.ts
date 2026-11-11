import { join } from "node:path";
import {
  createMaskStore,
  Orchestrator,
  SkillRegistry,
  type MaskStore,
} from "@agentdesk/agent-core";
import { BrowserSessionManager } from "@agentdesk/integrations";
import { createAgentDefinitions } from "./agents/definitions";
import { buildToolRegistry } from "./agents/tools";
import { registerPresentationTools } from "./agents/presentation-tools";
import { registerDocumentTools } from "./agents/document-tools";
import { registerRepoReadingTools, withRepoReading } from "./agents/repo-reading-tools";
import { RepositorySource } from "./services/repo-reading/source";
import { RepoReadingService } from "./services/repo-reading/service";
import type { SidecarConfig } from "./config";
import { openDatabase, type DbHandle } from "./db/client";
import { EventHub } from "./events";
import { SecretStore } from "./secrets";
import { ApprovalService } from "./services/approvals";
import { AutoloopService } from "./services/autoloop/service";
import { AutoloopStore } from "./services/autoloop/store";
import { createAutoApprove } from "./services/auto-approve";
import { BrowserService } from "./services/browser";
import { ChatService } from "./services/chat";
import { ConversationStore } from "./services/conversation-store";
import { ConversationContextService } from "./services/conversation-context";
import { ProjectInsightService } from "./services/project-insights";
import { DeployService } from "./services/deploy";
import { DiskService } from "./services/disk";
import { FeedService } from "./services/feed";
import { ReachService } from "./services/reach";
import { LearningService } from "./services/learning";
import { LearningLibraryService } from "./services/learning-library";
import { InterviewService } from "./services/interview";
import { MemoryService } from "./services/memory";
import { EvaluationService } from "./services/evaluation";
import { EvolutionService } from "./services/evolution";
import { ProjectService } from "./services/projects";
import { ProjectInstructionService } from "./services/project-instructions";
import { PermissionRuleService } from "./services/permission-rules";
import { ProviderService } from "./services/providers";
import { PromptOptimizationService } from "./services/prompt-optimization";
import { Scheduler } from "./services/scheduler";
import { SettingsService } from "./services/settings";
import { createOrchestratorExecutor } from "./services/task-executor";
import { TaskService } from "./services/tasks";
import { readRemoteTask } from "./services/remote/task-contexts";
import { RemoteGrantStore } from "./services/remote/grants";
import { RemoteApprovalService } from "./services/remote/approvals";
import { CloudRunnerService } from "./services/remote/runner";
import { RepositoryOperationService } from "./services/remote/repository-operations";
import { RemoteOperationStore } from "./services/remote/operations";
import { CodexExecutorService } from "./services/executors/codex";
import { CloudRepositorySetup } from "./services/remote/repository-setup";
import { WorkspaceTransferService } from "./services/workspace-transfer/service";
import type { RunExecutor } from "./services/tasks";
import { WechatReportService } from "./services/wechat-report";
import { WorkflowService } from "./services/workflows";

export interface Container {
  config: SidecarConfig;
  dbHandle: DbHandle;
  hub: EventHub;
  secrets: SecretStore;
  settings: SettingsService;
  approvals: ApprovalService;
  autoloop: AutoloopService;
  permissionRules: PermissionRuleService;
  providers: ProviderService;
  promptOptimization: PromptOptimizationService;
  projects: ProjectService;
  projectInstructions: ProjectInstructionService;
  feed: FeedService;
  reach: ReachService;
  learning: LearningService;
  library: LearningLibraryService;
  interview: InterviewService;
  memory: MemoryService;
  evaluation: EvaluationService;
  evolution: EvolutionService;
  disk: DiskService;
  deploy: DeployService;
  browser: BrowserService;
  skills: SkillRegistry;
  wechat: WechatReportService | null;
  orchestrator: Orchestrator;
  chat: ChatService;
  context: ConversationContextService;
  insights: ProjectInsightService;
  tasks: TaskService;
  workflows: WorkflowService;
  scheduler: Scheduler;
  registry: ReturnType<typeof buildToolRegistry>;
  cloudRunner: CloudRunnerService | null;
  remoteGrants: RemoteGrantStore | null;
  remoteApprovals: RemoteApprovalService | null;
  repositoryOperations: RepositoryOperationService | null;
  codex: CodexExecutorService | null;
  cloudRepositorySetup: CloudRepositorySetup | null;
  workspaceTransfers: WorkspaceTransferService | null;
  shutdownSignal: AbortSignal;
  beginShutdown: () => void;
  dispose: () => Promise<void>;
}

export async function createContainer(
  config: SidecarConfig,
  options: {
    inMemory?: boolean;
    autoloopFetch?: typeof fetch;
    cloud?: { hostId: string; workspaceRoot: string; taskTimeoutMs: number };
    office?: { hostId: string; projects: Record<string, string>; taskTimeoutMs: number };
  } = {},
): Promise<Container> {
  const dbHandle = openDatabase(options.inMemory ? ":memory:" : config.dataDir);
  const db = dbHandle.db;
  const hub = new EventHub();
  const shutdown = new AbortController();
  const secrets = new SecretStore(db, config.masterKey, config.dataDir);
  const settings = new SettingsService(db);
  const approvals = new ApprovalService(db, hub);
  const permissionRules = new PermissionRuleService(db);
  const providers = new ProviderService(db, secrets, settings);
  const autoApprove = options.cloud
    ? async () => ({ approved: false as const, note: "Cloud runs require explicit approval" })
    : createAutoApprove(permissionRules, providers, settings);
  // 每次调用给一个全新的 MaskStore（按一次 /chat 请求或一个 Run 的生命周期隔离占位符映射），
  // 不开启时返回 undefined，agent-core 完全跳过脱敏逻辑。
  const maskFactory = (): MaskStore | undefined =>
    settings.get().contentMaskingEnabled ? createMaskStore() : undefined;
  const promptOptimization = new PromptOptimizationService(providers, {
    maskFactory,
    shutdownSignal: shutdown.signal,
  });
  const projects = new ProjectService(db, secrets, settings, providers, config.dataDir, hub);
  const projectInstructions = new ProjectInstructionService(projects);
  const lazyTasks: { current?: TaskService } = {};
  const remoteOptions =
    options.cloud ??
    (options.office ? { ...options.office, workspaceRoot: config.dataDir } : undefined);
  const remoteGrants = remoteOptions
    ? new RemoteGrantStore(dbHandle.raw, remoteOptions.hostId)
    : null;
  const cloudRunner = remoteOptions
    ? new CloudRunnerService(
        dbHandle.raw,
        remoteOptions.hostId,
        remoteOptions.workspaceRoot,
        remoteOptions.taskTimeoutMs,
        projects,
        remoteGrants!,
        approvals,
        () => lazyTasks.current!,
        permissionRules,
        options.office?.projects,
      )
    : null;
  const remoteApprovals = remoteOptions ? new RemoteApprovalService(dbHandle.raw, approvals) : null;
  const workspaceTransfers = cloudRunner
    ? new WorkspaceTransferService(
        dbHandle.raw,
        join(config.dataDir, "workspace-transfer"),
        (scope) => cloudRunner.resolveWorkspace(scope),
        cloudRunner.locks,
        projects,
        remoteOptions!.workspaceRoot,
      )
    : null;
  workspaceTransfers?.startCleanup();
  const codex = cloudRunner
    ? new CodexExecutorService(
        dbHandle.raw,
        config.dataDir,
        cloudRunner,
        approvals,
        () => lazyTasks.current!,
      )
    : null;
  const cloudRepositorySetup = options.cloud
    ? new CloudRepositorySetup(
        dbHandle.raw,
        secrets,
        projects,
        config.dataDir,
        options.cloud.workspaceRoot,
      )
    : null;
  const repositoryOperations = cloudRunner
    ? new RepositoryOperationService({
        grants: remoteGrants!,
        operations: new RemoteOperationStore(dbHandle.raw),
        approvals,
        remoteApprovals: remoteApprovals!,
        resolveWorkspace: (scope) => cloudRunner.resolveWorkspace(scope),
        locks: cloudRunner.locks,
        gitConfig: (url) => cloudRepositorySetup?.gitConfig(url) ?? {},
      })
    : null;
  const feed = new FeedService(db, settings, providers, hub);
  const reach = new ReachService(db, secrets);
  const memory = new MemoryService(dbHandle.raw, providers);
  const evaluation = new EvaluationService(dbHandle.raw, providers);
  const evolution = new EvolutionService(dbHandle.raw, providers, evaluation, shutdown.signal);
  const learning = new LearningService(db, providers);
  const library = new LearningLibraryService(db, providers);
  const interview = new InterviewService(db, providers, secrets);
  const disk = new DiskService(settings, providers, { extraProtected: [config.dataDir] });
  const browserManager = new BrowserSessionManager(
    join(config.dataDir, "browser-profiles"),
    () => settings.get().browserChannel,
  );
  const deploy = new DeployService(
    db,
    secrets,
    approvals,
    hub,
    providers,
    settings,
    config.dataDir,
    browserManager,
  );
  const browser = new BrowserService(browserManager, hub, config.dataDir);

  const skills = new SkillRegistry();
  await skills.loadFrom(config.skillDirs, {
    exclude: config.wechatReportEnabled ? [] : ["wechat-daily-report"],
  });
  const wechat = config.wechatReportEnabled
    ? new WechatReportService(skills, providers, config.dataDir)
    : null;

  // 工具注册表与工作流服务互相引用：工作流可调用工具，工具也可触发工作流
  const lazy: { workflows?: WorkflowService } = {};
  const registry = buildToolRegistry({
    projects,
    feed,
    reach,
    memory,
    disk,
    deploy,
    browser,
    settings,
    hub,
    workflows: () => {
      if (!lazy.workflows) throw new Error("工作流服务尚未初始化");
      return lazy.workflows;
    },
  });
  const artifactRoot = join(config.dataDir, "generated-artifacts");
  registerPresentationTools(registry, artifactRoot);
  registerDocumentTools(registry, artifactRoot);
  registerRepoReadingTools(
    registry,
    new RepoReadingService(db, new RepositorySource(projects), providers, maskFactory),
  );
  const remoteRegistry = cloudRunner?.restrictedRegistry(registry);
  const effectiveRegistry = options.cloud ? remoteRegistry! : registry;
  const orchestrator = new Orchestrator({
    agents: withRepoReading(createAgentDefinitions(config.wechatReportEnabled)),
    registry: effectiveRegistry,
    resolver: providers,
    skills,
  });
  const workflows = new WorkflowService({
    db,
    hub,
    approvals,
    providers,
    orchestrator,
    registry: effectiveRegistry,
    projects,
    deploy,
  });
  lazy.workflows = workflows;

  // TaskService 的真实 executor 需要引用 TaskService 自身（委派产生子 Run、写 run_events），
  // 而 TaskService 的构造又需要先拿到 executor：用 lazyTasks 打破这个循环依赖，
  // executor 内部让出一次微任务后才会用到它，构造完成时机已经晚于下面的赋值。
  const conversationStore = new ConversationStore(db);
  const context = new ConversationContextService(db, providers, { maskFactory });
  const baseExecutor = createOrchestratorExecutor({
    getTasks: () => lazyTasks.current!,
    orchestrator,
    approvals,
    conversationStore,
    context,
    registry: effectiveRegistry,
    projectInstructions,
    memory,
    evolution: remoteOptions ? undefined : evolution,
    autoApprove,
    maskFactory,
  });
  const remoteExecutor = cloudRunner
    ? createOrchestratorExecutor({
        getTasks: () => lazyTasks.current!,
        orchestrator: new Orchestrator({
          agents: withRepoReading(createAgentDefinitions(false)),
          registry: remoteRegistry!,
          resolver: providers,
          skills,
        }),
        approvals,
        conversationStore,
        context,
        registry: remoteRegistry!,
        projectInstructions,
        autoApprove: async () => ({
          approved: false as const,
          note: "Remote runs require explicit approval",
        }),
        maskFactory,
        cloudPolicy: {
          allowedTools: remoteRegistry!.list().map((tool) => tool.name),
          approvalCreated: (approval, task) => cloudRunner.bindApproval(approval, task),
          requiresPlan: (task) => cloudRunner.requiresPlan(task),
        },
      })
    : undefined;
  const executor: RunExecutor = (run, task, signal) => {
    if (cloudRunner && readRemoteTask(dbHandle.raw, task.id))
      return cloudRunner.withRun(run, task, signal, (executionSignal) =>
        cloudRunner.context(task.id).executor === "codex"
          ? codex!.execute(run, task, executionSignal)
          : remoteExecutor!(run, task, executionSignal),
      );
    if (options.cloud) throw new Error("Cloud task is missing its remote authorization");
    return baseExecutor(run, task, signal);
  };
  const tasks = new TaskService(db, hub, {
    executor,
    artifactRoot,
    maxConcurrentRuns: cloudRunner ? 1 : undefined,
    authorizeRemoteRun: cloudRunner ? (run) => cloudRunner.authorizeRun(run) : undefined,
  });
  lazyTasks.current = tasks;
  const autoloop = new AutoloopService({
    store: new AutoloopStore(db),
    secrets,
    dataDir: config.dataDir,
    tasks,
    registry,
    providers,
    projects,
    projectInstructions,
    permissionRules,
    maskFactory,
    fetchImpl: options.autoloopFetch,
  });
  if (!options.cloud)
    await autoloop.start().catch(() => console.warn("[autoloop] 后台启动未完成，自动化状态已保留"));
  const chat = new ChatService(
    db,
    orchestrator,
    approvals,
    memory,
    tasks,
    projectInstructions,
    autoApprove,
    maskFactory,
  );
  chat.setContextService(context);
  if (!remoteOptions) chat.setEvolutionService(evolution);
  const insights = new ProjectInsightService(db, projects, tasks, providers, maskFactory);
  const scheduler = new Scheduler(db, settings, feed, workflows);

  return {
    config,
    dbHandle,
    hub,
    secrets,
    settings,
    approvals,
    autoloop,
    permissionRules,
    providers,
    promptOptimization,
    projects,
    projectInstructions,
    feed,
    reach,
    learning,
    library,
    interview,
    memory,
    evaluation,
    evolution,
    disk,
    deploy,
    browser,
    skills,
    wechat,
    orchestrator,
    chat,
    context,
    insights,
    tasks,
    workflows,
    scheduler,
    registry: effectiveRegistry,
    cloudRunner,
    remoteGrants,
    remoteApprovals,
    repositoryOperations,
    codex,
    cloudRepositorySetup,
    workspaceTransfers,
    shutdownSignal: shutdown.signal,
    beginShutdown: () => {
      shutdown.abort();
      cloudRepositorySetup?.stop();
      void tasks.shutdown();
    },
    dispose: async () => {
      shutdown.abort();
      cloudRepositorySetup?.stop();
      scheduler.stop();
      const draining = tasks.shutdown();
      await cloudRepositorySetup?.dispose();
      await codex?.dispose();
      await autoloop.dispose();
      await chat.dispose();
      reach.dispose();
      await insights.dispose();
      await interview.dispose();
      await draining;
      await workspaceTransfers?.dispose();
      await browserManager.closeAll();
      dbHandle.close();
    },
  };
}
