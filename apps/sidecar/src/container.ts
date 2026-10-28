import { join } from "node:path";
import { Orchestrator, SkillRegistry } from "@agentdesk/agent-core";
import { BrowserSessionManager } from "@agentdesk/integrations";
import { createAgentDefinitions } from "./agents/definitions";
import { buildToolRegistry } from "./agents/tools";
import type { SidecarConfig } from "./config";
import { openDatabase, type DbHandle } from "./db/client";
import { EventHub } from "./events";
import { SecretStore } from "./secrets";
import { ApprovalService } from "./services/approvals";
import { BrowserService } from "./services/browser";
import { ChatService } from "./services/chat";
import { ConversationStore } from "./services/conversation-store";
import { DeployService } from "./services/deploy";
import { DiskService } from "./services/disk";
import { FeedService } from "./services/feed";
import { MemoryService } from "./services/memory";
import { ProjectService } from "./services/projects";
import { ProjectInstructionService } from "./services/project-instructions";
import { ProviderService } from "./services/providers";
import { Scheduler } from "./services/scheduler";
import { SettingsService } from "./services/settings";
import { createOrchestratorExecutor } from "./services/task-executor";
import { TaskService } from "./services/tasks";
import { WechatReportService } from "./services/wechat-report";
import { WorkflowService } from "./services/workflows";

export interface Container {
  config: SidecarConfig;
  dbHandle: DbHandle;
  hub: EventHub;
  secrets: SecretStore;
  settings: SettingsService;
  approvals: ApprovalService;
  providers: ProviderService;
  projects: ProjectService;
  projectInstructions: ProjectInstructionService;
  feed: FeedService;
  memory: MemoryService;
  disk: DiskService;
  deploy: DeployService;
  browser: BrowserService;
  skills: SkillRegistry;
  wechat: WechatReportService | null;
  orchestrator: Orchestrator;
  chat: ChatService;
  tasks: TaskService;
  workflows: WorkflowService;
  scheduler: Scheduler;
  registry: ReturnType<typeof buildToolRegistry>;
  dispose: () => Promise<void>;
}

export async function createContainer(
  config: SidecarConfig,
  options: { inMemory?: boolean } = {},
): Promise<Container> {
  const dbHandle = openDatabase(options.inMemory ? ":memory:" : config.dataDir);
  const db = dbHandle.db;
  const hub = new EventHub();
  const secrets = new SecretStore(db, config.masterKey, config.dataDir);
  const settings = new SettingsService(db);
  const approvals = new ApprovalService(db, hub);
  const providers = new ProviderService(db, secrets, settings);
  const projects = new ProjectService(db, secrets, settings, providers, config.dataDir, hub);
  const projectInstructions = new ProjectInstructionService(projects);
  const feed = new FeedService(db, settings, providers, hub);
  const memory = new MemoryService(dbHandle.raw, providers);
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
  const orchestrator = new Orchestrator({
    agents: createAgentDefinitions(config.wechatReportEnabled),
    registry,
    resolver: providers,
    skills,
  });
  const workflows = new WorkflowService({
    db,
    hub,
    approvals,
    providers,
    orchestrator,
    registry,
    projects,
    deploy,
  });
  lazy.workflows = workflows;

  // TaskService 的真实 executor 需要引用 TaskService 自身（委派产生子 Run、写 run_events），
  // 而 TaskService 的构造又需要先拿到 executor：用 lazyTasks 打破这个循环依赖，
  // executor 内部让出一次微任务后才会用到它，构造完成时机已经晚于下面的赋值。
  const lazyTasks: { current?: TaskService } = {};
  const conversationStore = new ConversationStore(db);
  const taskExecutor = createOrchestratorExecutor({
    getTasks: () => lazyTasks.current!,
    orchestrator,
    approvals,
    conversationStore,
    registry,
    projectInstructions,
  });
  const tasks = new TaskService(db, hub, { executor: taskExecutor });
  lazyTasks.current = tasks;
  const chat = new ChatService(db, orchestrator, approvals, memory, tasks, projectInstructions);
  const scheduler = new Scheduler(db, settings, feed, workflows);

  return {
    config,
    dbHandle,
    hub,
    secrets,
    settings,
    approvals,
    providers,
    projects,
    projectInstructions,
    feed,
    memory,
    disk,
    deploy,
    browser,
    skills,
    wechat,
    orchestrator,
    chat,
    tasks,
    workflows,
    scheduler,
    registry,
    dispose: async () => {
      scheduler.stop();
      await browserManager.closeAll();
      dbHandle.close();
    },
  };
}
