import { AppSettings } from "@agentdesk/shared";
import type {
  DeployRecipe,
  DeployRun,
  FeedItem,
  Project,
  RunEventRecord,
  Task,
  TaskStreamEvent,
} from "@agentdesk/shared";
import type { Workflow } from "@agentdesk/workflow/dsl";

// 仅供文档截图使用的演示数据，不读取本机配置、仓库或会话。
export const demoTime = "2026-10-29T02:30:00.000Z";
const updatedAt = "2026-10-29T02:20:00.000Z";

const projectNames = [
  "portal-web",
  "agent-workflows",
  "design-system",
  "docs-site",
  "api-service",
  "task-worker",
];
const commitMessages = [
  "fix: 恢复页面刷新后的登录状态",
  "feat: 添加任务审批与运行记录",
  "feat: 统一组件的主题与交互",
  "docs: 完善快速开始和部署指南",
  "test: 补充接口集成测试",
  "refactor: 简化后台任务调度",
];
export const projects: Project[] = projectNames.map((name, i) => ({
  id: name,
  name,
  path: `D:/Projects/${name}`,
  platform: i === 4 ? "gitee" : "github",
  remoteUrl: `https://example.com/demo/${name}.git`,
  host: "example.com",
  owner: "demo-workspace",
  repo: name,
  branch: i === 0 ? "fix/session-restore" : "main",
  dirtyFiles: i === 0 ? 2 : i === 2 ? 3 : 0,
  ahead: i === 1 ? 2 : 0,
  behind: 0,
  lastCommit: { hash: "a1b2c3d", message: commitMessages[i]!, author: "Demo", date: updatedAt },
  pinned: i < 2,
  tags: [],
  scannedAt: updatedAt,
  stars: null,
  prevStars: null,
}));

export const feed: FeedItem[] = [
  [
    "openai/codex",
    "在终端完成代码阅读、修改与验证的编程 Agent。关注任务执行、工具调用与开发者体验。",
    "Rust",
    "ai",
  ],
  [
    "cline/cline",
    "集成到编辑器中的编程助手，将文件编辑、终端操作和人工审批串联起来。",
    "TypeScript",
    "ai",
  ],
  [
    "langchain-ai/langgraph",
    "通过图结构编排有状态的 Agent 流程，支持持久化、人工介入与执行恢复。",
    "Python",
    "ai",
  ],
  [
    "microsoft/playwright",
    "面向现代 Web 的浏览器自动化工具，支持跨浏览器测试、截图与执行追踪。",
    "TypeScript",
    "devops",
  ],
  [
    "vitejs/vite",
    "提供快速开发服务器与生产构建的前端工具链，适用于现代 Web 应用。",
    "TypeScript",
    "frontend",
  ],
  ["ollama/ollama", "在本机运行和管理开源模型，为应用提供统一的本地推理接口。", "Go", "ai"],
].map(([title, summary, language, tag], i) => ({
  id: `feed-${i}`,
  source: "github",
  title: title!,
  url: `https://github.com/${title}`,
  description: summary!,
  summaryZh: summary!,
  tags: [tag as "ai" | "devops" | "frontend"],
  language: language!,
  stars: null,
  starsToday: [128, 96, 88, 64, 52, 42][i]!,
  date: "2026-10-29",
  favorite: i === 0,
}));

export const task: Task = {
  id: "demo-session",
  title: "修复登录状态恢复，并验证改动",
  goal: "修复刷新页面后会话丢失的问题，处理无效缓存，并运行测试验证。",
  agent: "code",
  conversationId: "demo-conversation",
  requiresPlanApproval: false,
  status: "awaiting_review",
  currentRunId: "demo-run",
  pendingApprovalId: null,
  createdAt: updatedAt,
  updatedAt,
  closedAt: null,
};

const restoredSession = [
  '  const saved = sessionStorage.getItem("session");',
  "  if (!saved) return null;",
  "  try {",
  "    return JSON.parse(saved);",
  "  } catch {",
  '    sessionStorage.removeItem("session");',
  "    return null;",
  "  }",
];
const eventData: TaskStreamEvent[] = [
  { type: "run_started", runId: "demo-run", parentRunId: null, agent: "code", trigger: "create" },
  {
    type: "tool_call",
    id: "read",
    agent: "code",
    name: "fs.read",
    args: { path: "src/auth/session.ts" },
  },
  {
    type: "tool_result",
    id: "read",
    agent: "code",
    isError: false,
    result: { content: "export function restoreSession() {\n  return null;\n}" },
  },
  {
    type: "tool_call",
    id: "edit",
    agent: "code",
    name: "fs.patch",
    args: {
      path: "src/auth/session.ts",
      oldText: "  return null;",
      newText: restoredSession.join("\n"),
    },
  },
  {
    type: "file_change",
    agent: "code",
    toolCallId: "edit",
    change: {
      path: "D:/Projects/portal-web/src/auth/session.ts",
      operation: "edit",
      additions: 8,
      deletions: 1,
      diff: [
        "--- a/src/auth/session.ts",
        "+++ b/src/auth/session.ts",
        "@@ -1,3 +1,10 @@",
        " export function restoreSession() {",
        "-  return null;",
        ...restoredSession.map((line) => `+${line}`),
        " }",
      ].join("\n"),
      truncated: false,
      beforeHash: "demo-before",
      afterHash: "demo-after",
    },
  },
  { type: "tool_result", id: "edit", agent: "code", isError: false, result: { replacements: 1 } },
  {
    type: "tool_call",
    id: "test",
    agent: "code",
    name: "shell.run",
    args: { command: "pnpm test -- session", cwd: "D:/Projects/portal-web" },
  },
  {
    type: "tool_output",
    toolCallId: "test",
    agent: "code",
    delta: "✓ session.test.ts (4 tests)\n\nTests  4 passed (4)\nDuration  418ms",
  },
  {
    type: "tool_result",
    id: "test",
    agent: "code",
    isError: false,
    result: { exitCode: 0, output: "Tests 4 passed (4)" },
  },
  {
    type: "text_delta",
    agent: "code",
    delta: "已恢复刷新后的会话读取，并处理无效缓存。\n\n4 项测试通过，可检查右侧差异后验收。",
  },
  { type: "run_ended", runId: "demo-run", status: "succeeded" },
];
export const records: RunEventRecord[] = eventData.map((event, index) => ({
  seq: index + 1,
  taskId: task.id,
  runId: "demo-run",
  parentRunId: null,
  createdAt: updatedAt,
  event,
}));

const workflowNodes: Workflow["nodes"] = [
  {
    id: "start",
    type: "start",
    position: { x: 0, y: 0 },
    data: { label: "开始发布", config: {} },
  },
  {
    id: "review",
    type: "agent",
    position: { x: 290, y: 0 },
    data: {
      label: "检查项目状态",
      config: { agent: "project", task: "检查仓库分支、改动与测试结果" },
    },
  },
  {
    id: "approve",
    type: "approval",
    position: { x: 0, y: 200 },
    data: {
      label: "确认发布范围",
      config: { title: "发布审批", detail: "检查本次更新内容后继续" },
    },
  },
  {
    id: "deploy",
    type: "deploy",
    position: { x: 290, y: 200 },
    data: { label: "部署到预览环境", config: { recipeId: "portal-preview" } },
  },
  {
    id: "notify",
    type: "notify",
    position: { x: 0, y: 400 },
    data: {
      label: "发送完成通知",
      config: { title: "预览环境已更新", body: "部署与健康检查已完成" },
    },
  },
  {
    id: "end",
    type: "end",
    position: { x: 290, y: 400 },
    data: { label: "发布完成", config: { output: "发布成功" } },
  },
];
const nodeOrder = ["start", "review", "approve", "deploy", "notify", "end"];
export const workflow: Workflow = {
  id: "demo-release",
  name: "项目发布 · 审批与部署",
  description: "检查仓库 → 人工审批 → 部署验证 → 完成通知",
  version: 3,
  trigger: { type: "manual" },
  inputs: [],
  updatedAt,
  nodes: workflowNodes,
  edges: nodeOrder
    .slice(1)
    .map((target, i) => ({ id: `edge-${i}`, source: nodeOrder[i]!, target })),
};

export const recipe: DeployRecipe = {
  id: "portal-preview",
  name: "Portal · 预览环境",
  serverId: "demo-server",
  projectId: "portal-web",
  description: "拉取代码、安装依赖、构建、重启与健康检查",
  updatedAt,
  steps: [
    { type: "login" },
    { type: "terminal", command: "git pull --ff-only", timeoutMs: 120000, label: "拉取最新代码" },
    {
      type: "terminal",
      command: "pnpm install --frozen-lockfile",
      timeoutMs: 120000,
      label: "安装项目依赖",
    },
    { type: "terminal", command: "pnpm build", timeoutMs: 120000, label: "构建生产版本" },
    { type: "restartProject", projectType: "node", projectName: "portal", label: "重启应用进程" },
    {
      type: "httpCheck",
      url: "https://preview.example.com/health",
      expectStatus: 200,
      retries: 5,
      label: "验证服务健康状态",
    },
  ],
};
export const deployRun: DeployRun = {
  id: "demo-deploy",
  recipeId: recipe.id,
  recipeName: recipe.name,
  status: "succeeded",
  error: null,
  createdAt: updatedAt,
  updatedAt,
  steps: [
    "登录宝塔面板",
    "拉取最新代码",
    "安装项目依赖",
    "构建生产版本",
    "重启应用进程",
    "验证服务健康状态",
  ].map((title, index) => ({
    index,
    title,
    status: "succeeded",
    screenshot: null,
    startedAt: updatedAt,
    endedAt: updatedAt,
    log:
      index === 3
        ? [
            "$ pnpm build",
            "✓ 182 modules transformed.",
            "dist/index.html       0.64 kB",
            "dist/assets/app.js   148.32 kB",
            "✓ built in 2.41s",
          ]
        : index === 5
          ? ["GET https://preview.example.com/health", "HTTP 200 OK · service healthy"]
          : ["Completed successfully"],
  })),
};

export const responses: Record<string, unknown> = {
  "/health": {
    ok: true,
    version: "0.1.0",
    dataDir: "D:/Demo/AgentDesk",
    secretBackend: "keychain",
    providers: 1,
    proxy: null,
  },
  "/settings": AppSettings.parse({}),
  "/disk/status": {
    platform: "win32",
    volumePath: "C:/",
    totalBytes: 1024 ** 4,
    freeBytes: 320 * 1024 ** 3,
    usedBytes: 704 * 1024 ** 3,
    thresholdBytes: 15 * 1024 ** 3,
    low: false,
  },
  "/approvals": [],
  "/providers": [
    {
      id: "demo-provider",
      name: "演示模型",
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      models: ["demo-model"],
      defaultModel: "demo-model",
      source: "manual",
      enabled: true,
      hasKey: false,
      createdAt: updatedAt,
    },
  ],
  "/agent-bindings": [],
  "/conversations": [
    { id: "demo-chat-1", title: "检查项目的待提交改动", createdAt: updatedAt, updatedAt },
    { id: "demo-chat-2", title: "整理今天的 Agent 开源项目", createdAt: updatedAt, updatedAt },
  ],
  "/projects": projects,
  "/projects/refresh-stars": { updated: 0, gained: 0 },
  "/claude/sessions": [],
  "/feed/dates": ["2026-10-29"],
  "/feed/digest": {
    date: "2026-10-29",
    headline: "从编码到验证，让 Agent 融入开发流程",
    markdown:
      "今日关注 **编程 Agent、流程编排与自动化验证**。先在本地完成一次小任务，再逐步接入项目工具与审批流程。",
    itemCount: feed.length,
    createdAt: updatedAt,
  },
  "/tasks": [
    task,
    {
      ...task,
      id: "demo-docs",
      title: "完善项目启动文档",
      status: "completed",
      updatedAt: "2026-10-28T08:00:00Z",
    },
    {
      ...task,
      id: "demo-theme",
      title: "统一组件的主题样式",
      status: "completed",
      updatedAt: "2026-10-27T08:00:00Z",
    },
  ],
  [`/tasks/${task.id}/runs`]: [
    {
      id: "demo-run",
      taskId: task.id,
      agent: "code",
      kind: "root",
      parentRunId: null,
      trigger: "create",
      status: "succeeded",
      createdAt: updatedAt,
    },
  ],
  "/servers": [
    {
      id: "demo-server",
      name: "预览服务器",
      panelUrl: "https://panel.example.com",
      username: "demo",
      hasPassword: false,
      notes: "文档演示环境",
      createdAt: updatedAt,
    },
  ],
  "/recipes": [recipe, { ...recipe, id: "docs-preview", name: "Docs · 文档站点" }],
  "/deploy/runs": [deployRun],
  [`/deploy/runs/${deployRun.id}`]: deployRun,
  [`/workflows/${workflow.id}`]: workflow,
};
