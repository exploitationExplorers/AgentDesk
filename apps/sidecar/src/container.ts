import { join } from "node:path";
import { Orchestrator, SkillRegistry } from "@agentdesk/agent-core";
import { BrowserSessionManager } from "@agentdesk/integrations";
import { AGENT_DEFINITIONS } from "./agents/definitions";
import { buildToolRegistry } from "./agents/tools";
import type { SidecarConfig } from "./config";
import { openDatabase, type DbHandle } from "./db/client";
import { EventHub } from "./events";
import { SecretStore } from "./secrets";
import { ApprovalService } from "./services/approvals";
import { BrowserService } from "./services/browser";
import { ChatService } from "./services/chat";
import { DeployService } from "./services/deploy";
import { DiskService } from "./services/disk";
import { FeedService } from "./services/feed";
import { MemoryService } from "./services/memory";
import { ProjectService } from "./services/projects";
import { ProviderService } from "./services/providers";
import { Scheduler } from "./services/scheduler";
import { SettingsService } from "./services/settings";
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
  feed: FeedService;
  memory: MemoryService;
  disk: DiskService;
  deploy: DeployService;
  browser: BrowserService;
  skills: SkillRegistry;
  wechat: WechatReportService;
  orchestrator: Orchestrator;
  chat: ChatService;
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
  await skills.loadFrom(config.skillDirs);
  const wechat = new WechatReportService(skills, providers, config.dataDir);

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
    agents: AGENT_DEFINITIONS,
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
  const chat = new ChatService(db, orchestrator, approvals, memory);
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
    feed,
    memory,
    disk,
    deploy,
    browser,
    skills,
    wechat,
    orchestrator,
    chat,
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
