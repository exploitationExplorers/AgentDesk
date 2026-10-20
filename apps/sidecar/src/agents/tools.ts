import { parse } from "node-html-parser";
import { ToolRegistry, Type, defineTool } from "@agentdesk/agent-core";
import { runShell } from "@agentdesk/integrations";
import type { RiskLevel } from "@agentdesk/shared";
import type { DeployService } from "../services/deploy";
import type { FeedService } from "../services/feed";
import type { ProjectService } from "../services/projects";
import type { WorkflowService } from "../services/workflows";
import { localDate } from "../util";

export interface ToolDeps {
  projects: ProjectService;
  feed: FeedService;
  deploy: DeployService;
  /** 工作流服务依赖工具注册表，这里延迟获取以打破循环依赖 */
  workflows: () => WorkflowService;
}

/** 只读命令白名单：命中时 shell.run 免审批 */
const READONLY_COMMANDS = [
  /^git (status|log|diff|branch|remote -v|fetch|show)\b/,
  /^(ls|dir|pwd|whoami|echo)\b/,
  /^(node|npm|pnpm|yarn|bun|python|go|java|cargo|rustc) (-v|--version)$/,
];

export function shellRisk(command: string): RiskLevel {
  const trimmed = command.trim();
  if (/[;&|`$><]/.test(trimmed)) return "dangerous";
  return READONLY_COMMANDS.some((r) => r.test(trimmed)) ? "safe" : "dangerous";
}

function htmlToText(html: string): string {
  const root = parse(html);
  root.querySelectorAll("script,style,nav,footer,svg,noscript").forEach((n) => n.remove());
  return (root.querySelector("article") ?? root.querySelector("main") ?? root).text
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildToolRegistry(deps: ToolDeps): ToolRegistry {
  const { projects, feed, deploy } = deps;
  const registry = new ToolRegistry();

  registry.register(
    defineTool({
      name: "projects.list",
      description: "列出工作台管理的所有本地项目（含平台、分支、未提交改动、最近提交）",
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: "按名称过滤" })),
      }),
      risk: "safe",
      execute: async ({ keyword }) =>
        projects
          .list()
          .filter((p) => !keyword || p.name.toLowerCase().includes(keyword.toLowerCase()))
          .map((p) => ({
            id: p.id,
            name: p.name,
            platform: p.platform,
            path: p.path,
            branch: p.branch,
            dirtyFiles: p.dirtyFiles,
            ahead: p.ahead,
            behind: p.behind,
            lastCommit: p.lastCommit
              ? `${p.lastCommit.message} (${p.lastCommit.date.slice(0, 10)})`
              : null,
          })),
    }),
    defineTool({
      name: "projects.status",
      description: "获取项目的实时 git 状态和最近 5 条提交",
      parameters: Type.Object({ project: Type.String({ description: "项目 ID、名称或路径" }) }),
      risk: "safe",
      execute: async ({ project }) => projects.status(project),
    }),
    defineTool({
      name: "projects.activity",
      description: "获取项目在 GitHub/Gitee/GitLab 上的开放 PR/MR 和 Issue",
      parameters: Type.Object({ project: Type.String({ description: "项目 ID、名称或路径" }) }),
      risk: "safe",
      execute: async ({ project }) => projects.activity(projects.find(project).id),
    }),
    defineTool({
      name: "projects.open",
      description: "在 Cursor、Claude Code（新终端）、终端或文件管理器中打开项目",
      parameters: Type.Object({
        project: Type.String({ description: "项目 ID、名称或路径" }),
        target: Type.Union([
          Type.Literal("cursor"),
          Type.Literal("claude"),
          Type.Literal("terminal"),
          Type.Literal("explorer"),
        ]),
      }),
      risk: "safe",
      execute: async ({ project, target }) => {
        const p = projects.launch(project, target);
        return `已在 ${target} 中打开 ${p.name}`;
      },
    }),
    defineTool({
      name: "projects.pull",
      description: "对本地项目执行 git pull --ff-only",
      parameters: Type.Object({ project: Type.String() }),
      risk: "confirm",
      describeApproval: ({ project }) => ({
        title: `git pull ${project}`,
        detail: "以 fast-forward 方式拉取远端最新代码",
      }),
      execute: async ({ project }) => projects.pull(project),
    }),
    defineTool({
      name: "projects.scan",
      description: "重新扫描配置目录下的 Git 仓库",
      parameters: Type.Object({}),
      risk: "safe",
      execute: async () => projects.scan(),
    }),
    defineTool({
      name: "claude.sessions",
      description: "列出最近的 Claude Code 会话（可按项目过滤）",
      parameters: Type.Object({ project: Type.Optional(Type.String()) }),
      risk: "safe",
      execute: async ({ project }) =>
        projects.claudeSessions(project ? projects.find(project).id : undefined),
    }),

    defineTool({
      name: "deploy.list",
      description: "列出宝塔服务器和部署配方",
      parameters: Type.Object({}),
      risk: "safe",
      execute: async () => ({
        servers: deploy
          .listServers()
          .map((s) => ({ id: s.id, name: s.name, panel: new URL(s.panelUrl).host })),
        recipes: deploy
          .listRecipes()
          .map((r) => ({ id: r.id, name: r.name, serverId: r.serverId, steps: r.steps.length })),
      }),
    }),
    defineTool({
      name: "deploy.runs",
      description: "查看最近的部署记录及失败步骤日志",
      parameters: Type.Object({ recipeId: Type.Optional(Type.String()) }),
      risk: "safe",
      execute: async ({ recipeId }) =>
        deploy
          .listRuns(recipeId)
          .slice(0, 5)
          .map((r) => ({
            id: r.id,
            recipe: r.recipeName,
            status: r.status,
            error: r.error,
            createdAt: r.createdAt,
            failedStep: r.steps.find((s) => s.status === "failed"),
          })),
    }),
    defineTool({
      name: "deploy.run",
      description: "执行部署配方（浏览器自动化操作宝塔面板），等待完成后返回结果",
      parameters: Type.Object({ recipeId: Type.String() }),
      risk: "dangerous",
      describeApproval: ({ recipeId }) => {
        const recipe = deploy.getRecipe(recipeId);
        return {
          title: `部署「${recipe.name}」`,
          detail: recipe.steps
            .map((s, i) => `${i + 1}. ${s.type}${"label" in s && s.label ? ` - ${s.label}` : ""}`)
            .join("\n"),
        };
      },
      execute: async ({ recipeId }) => {
        const run = deploy.start(recipeId, { skipApproval: true });
        const final = await deploy.wait(run.id);
        return {
          runId: final.id,
          status: final.status,
          error: final.error,
          steps: final.steps.map((s) => ({
            title: s.title,
            status: s.status,
            lastLog: s.log.at(-1),
          })),
        };
      },
    }),

    defineTool({
      name: "feed.today",
      description: "获取某天（默认今天）的技术热榜，可按来源或标签过滤",
      parameters: Type.Object({
        date: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
        source: Type.Optional(
          Type.Union([
            Type.Literal("github"),
            Type.Literal("huggingface"),
            Type.Literal("hackernews"),
          ]),
        ),
        tag: Type.Optional(Type.String({ description: "ai/frontend/backend/devops/mobile" })),
        limit: Type.Optional(Type.Number({ default: 30 })),
      }),
      risk: "safe",
      execute: async ({ date, source, tag, limit }) => {
        const items = feed.list({ date: date ?? localDate(), source, tag, limit: limit ?? 30 });
        if (items.length === 0) return "当天还没有热榜数据，可以调用 feed.refresh 刷新";
        return items.map((i) => ({
          title: i.title,
          url: i.url,
          source: i.source,
          summary: i.summaryZh ?? i.description,
          tags: i.tags,
          stars: i.stars,
          starsToday: i.starsToday,
        }));
      },
    }),
    defineTool({
      name: "feed.search",
      description: "在历史热榜中搜索关键词",
      parameters: Type.Object({ q: Type.String() }),
      risk: "safe",
      execute: async ({ q }) =>
        feed.list({ q, limit: 20 }).map((i) => ({
          date: i.date,
          title: i.title,
          url: i.url,
          summary: i.summaryZh ?? i.description,
        })),
    }),
    defineTool({
      name: "feed.refresh",
      description: "立即抓取今日 GitHub Trending、HuggingFace、HackerNews 并生成中文摘要",
      parameters: Type.Object({}),
      risk: "safe",
      execute: async () => feed.refresh(),
    }),
    defineTool({
      name: "feed.digest",
      description: "生成或获取某天的技术速览（Markdown）",
      parameters: Type.Object({ date: Type.Optional(Type.String()) }),
      risk: "safe",
      execute: async ({ date }) =>
        (feed.getDigest(date) ?? (await feed.generateDigest(date))).markdown,
    }),
    defineTool({
      name: "web.fetch",
      description: "读取网页正文（README、文档、博客），返回纯文本",
      parameters: Type.Object({ url: Type.String() }),
      risk: "safe",
      execute: async ({ url }, ctx) => {
        const target = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)
          ? `${url.replace(/\/$/, "").replace("github.com", "raw.githubusercontent.com")}/HEAD/README.md`
          : url;
        const response = await fetch(target, {
          signal: ctx.signal ?? AbortSignal.timeout(20_000),
          headers: { "User-Agent": "AgentDesk" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        const text = (response.headers.get("content-type") ?? "").includes("html")
          ? htmlToText(body)
          : body;
        return text.slice(0, 12_000);
      },
    }),

    defineTool({
      name: "workflow.list",
      description: "列出已保存的工作流",
      parameters: Type.Object({}),
      risk: "safe",
      execute: async () =>
        deps
          .workflows()
          .list()
          .map((w) => ({
            id: w.id,
            name: w.name,
            description: w.description,
            inputs: w.inputs.map((i) => i.name),
          })),
    }),
    defineTool({
      name: "workflow.run",
      description: "运行一个工作流并等待结果",
      parameters: Type.Object({
        id: Type.String(),
        inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      risk: "confirm",
      describeApproval: ({ id, inputs }) => ({
        title: `运行工作流「${deps.workflows().get(id).name}」`,
        detail: JSON.stringify(inputs ?? {}, null, 2),
      }),
      execute: async ({ id, inputs }) => {
        const run = deps.workflows().run(id, inputs ?? {});
        const final = await deps.workflows().wait(run.id);
        return { runId: final.id, status: final.status, output: final.output, error: final.error };
      },
    }),

    defineTool({
      name: "shell.run",
      description: "在本地执行命令行（只读命令直接执行，其余需要审批）",
      parameters: Type.Object({
        command: Type.String(),
        cwd: Type.Optional(Type.String({ description: "工作目录，或项目名称" })),
      }),
      risk: "dangerous",
      riskFor: ({ command }) => shellRisk(command),
      describeApproval: ({ command, cwd }) => ({
        title: `执行命令：${command}`,
        detail: `工作目录：${cwd ?? "(默认)"}`,
      }),
      execute: async ({ command, cwd }, ctx) => {
        let dir = cwd;
        if (cwd) {
          try {
            dir = projects.find(cwd).path;
          } catch {
            dir = cwd;
          }
        }
        const result = await runShell(command, {
          cwd: dir,
          timeoutMs: 5 * 60_000,
          signal: ctx.signal,
        });
        return { exitCode: result.code, output: (result.stdout + result.stderr).slice(-8000) };
      },
    }),
  );
  return registry;
}
