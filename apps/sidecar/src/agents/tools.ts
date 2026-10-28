import { parse } from "node-html-parser";
import { ToolRegistry, Type, defineTool } from "@agentdesk/agent-core";
import {
  fsGlob,
  fsPatch,
  fsRead,
  fsSearch,
  fsWrite,
  gitChangedFiles,
  runClaudePrint,
  runShell,
} from "@agentdesk/integrations";
import type { RiskLevel } from "@agentdesk/shared";
import { GLOBAL_CHANNEL, type EventHub, type GlobalEvent } from "../events";
import type { BrowserService } from "../services/browser";
import type { DeployService } from "../services/deploy";
import type { FeedService } from "../services/feed";
import type { DiskService } from "../services/disk";
import type { MemoryService } from "../services/memory";
import type { ProjectService } from "../services/projects";
import type { SettingsService } from "../services/settings";
import type { WorkflowService } from "../services/workflows";
import { localDate } from "../util";

export interface ToolDeps {
  projects: ProjectService;
  feed: FeedService;
  memory: MemoryService;
  disk: DiskService;
  deploy: DeployService;
  browser: BrowserService;
  settings: SettingsService;
  hub: EventHub;
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
  const { projects, feed, memory, disk, deploy, browser, settings, hub } = deps;
  const registry = new ToolRegistry();

  const projectRoot = (ref: string) => projects.find(ref).path;

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
      name: "claude.run",
      description:
        "无头调用本机 Claude Code（claude --print）在指定项目仓库里改代码并返回结论。修禅道 bug / 本地改文件优先用此工具，不要只靠 fs.search 空转。",
      parameters: Type.Object({
        project: Type.String({ description: "项目 ID、名称或路径" }),
        prompt: Type.String({ description: "交给 Claude Code 的完整任务说明（含复现与约束）" }),
        timeoutMin: Type.Optional(Type.Number({ description: "超时分钟数，默认 30，最大 90" })),
        requireChanges: Type.Optional(
          Type.Boolean({ description: "结束后必须有 git 改动，默认 true" }),
        ),
      }),
      risk: "dangerous",
      describeApproval: ({ project, prompt }) => {
        const p = projects.find(project);
        return {
          title: `Claude Code 改代码：${p.name}`,
          detail: `仓库：${p.path}\n\n${prompt.slice(0, 1200)}${prompt.length > 1200 ? "…" : ""}`,
        };
      },
      execute: async ({ project, prompt, timeoutMin, requireChanges }, ctx) => {
        const p = projects.find(project);
        const minutes = Math.min(90, Math.max(5, timeoutMin ?? 30));
        const needChanges = requireChanges !== false;
        let buffer = "";
        const flushLog = (force = false) => {
          if (!buffer) return;
          // 有换行就刷，保证 [Claude]/[git] 进度立刻进工作流日志
          if (!force && !buffer.includes("\n") && buffer.length < 80) return;
          const chunk = buffer;
          buffer = "";
          ctx.emit({ type: "text_delta", agent: ctx.agent, delta: chunk });
        };

        hub.publish(GLOBAL_CHANNEL, {
          type: "notification",
          title: `Claude Code 开始：${p.name}`,
          body: prompt.slice(0, 200),
        } satisfies GlobalEvent);
        ctx.emit({
          type: "text_delta",
          agent: ctx.agent,
          delta: `[claude.run] 仓库 ${p.path}\n[claude.run] 超时 ${minutes} 分钟；日志会出现 [Claude] 工具调用与 [git] 已改动\n`,
        });

        const result = await runClaudePrint({
          cwd: p.path,
          prompt,
          claudeCommand: settings.get().claudeCommand,
          timeoutMs: minutes * 60_000,
          signal: ctx.signal,
          permissionMode: "acceptEdits",
          onOutput: (chunk) => {
            buffer += chunk;
            flushLog();
          },
        });
        flushLog(true);

        if (result.exitCode !== 0) {
          hub.publish(GLOBAL_CHANNEL, {
            type: "notification",
            title: `Claude Code 失败：${p.name}`,
            body: (result.text || result.raw).slice(0, 400),
          } satisfies GlobalEvent);
          throw new Error(
            `Claude Code 退出码 ${result.exitCode}：${(result.text || result.raw).slice(0, 800)}`,
          );
        }

        const changedFiles = await gitChangedFiles(p.path, ctx.signal);
        if (needChanges && changedFiles.length === 0) {
          hub.publish(GLOBAL_CHANNEL, {
            type: "notification",
            title: `Claude Code 无改动：${p.name}`,
            body: "进程成功结束，但 git 工作区没有文件变更",
          } satisfies GlobalEvent);
          throw new Error(
            "Claude Code 未产生文件改动（git status 干净）。请检查任务说明或权限后重试。",
          );
        }

        const text = (result.text || "").trim() || "(Claude 无文本结论)";
        hub.publish(GLOBAL_CHANNEL, {
          type: "notification",
          title: `Claude Code 完成：${p.name}`,
          body:
            changedFiles.length > 0
              ? `改动 ${changedFiles.length} 个文件：${changedFiles.slice(0, 8).join(", ")}`
              : text.slice(0, 200),
        } satisfies GlobalEvent);

        return {
          text,
          changedFiles,
          sessionId: result.sessionId ?? null,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          project: p.name,
          path: p.path,
        };
      },
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

    defineTool({
      name: "browser.open",
      description:
        "打开 Playwright 浏览器会话（桌面实况面板会显示截图）。sessionId 可固定如 zentao 以复用登录 Cookie",
      parameters: Type.Object({
        url: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        headless: Type.Optional(Type.Boolean()),
      }),
      risk: "confirm",
      describeApproval: ({ url, sessionId }) => ({
        title: "打开浏览器会话",
        detail: `session=${sessionId ?? "(自动)"} url=${url ?? "(空白页)"}`,
      }),
      execute: async ({ url, sessionId, headless }) =>
        browser.open({ url, sessionId, headless: headless ?? true }),
    }),
    defineTool({
      name: "browser.act",
      description:
        "在已打开的浏览器会话上操作：goto/click/fill/press/wait/evaluate/screenshot。禅道登录填表、点按钮用此工具",
      parameters: Type.Object({
        sessionId: Type.String(),
        kind: Type.Union([
          Type.Literal("goto"),
          Type.Literal("click"),
          Type.Literal("fill"),
          Type.Literal("press"),
          Type.Literal("wait"),
          Type.Literal("evaluate"),
          Type.Literal("screenshot"),
        ]),
        target: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      risk: "confirm",
      riskFor: ({ kind }) => (kind === "screenshot" || kind === "wait" ? "safe" : "confirm"),
      describeApproval: ({ sessionId, kind, target }) => ({
        title: `浏览器 ${kind}`,
        detail: `session=${sessionId} target=${target ?? ""}`,
      }),
      execute: async ({ sessionId, kind, target, value, timeoutMs }) => {
        const { result, session } = await browser.act(sessionId, {
          kind,
          target,
          value,
          timeoutMs,
        });
        return { ...result, sessionId: session.id, shotUrl: session.lastShotUrl };
      },
    }),
    defineTool({
      name: "browser.snapshot",
      description: "读取当前页可见文本与常见 iframe 文本，并刷新实况截图",
      parameters: Type.Object({ sessionId: Type.String() }),
      risk: "safe",
      execute: async ({ sessionId }) => browser.snapshot(sessionId),
    }),
    defineTool({
      name: "browser.reveal",
      description: "有头弹出系统浏览器（同一 Cookie），用于验证码或人工接管",
      parameters: Type.Object({ sessionId: Type.String() }),
      risk: "safe",
      execute: async ({ sessionId }) => browser.reveal(sessionId),
    }),
    defineTool({
      name: "browser.close",
      description: "关闭浏览器会话",
      parameters: Type.Object({ sessionId: Type.String() }),
      risk: "safe",
      execute: async ({ sessionId }) => {
        await browser.close(sessionId);
        return { ok: true, sessionId };
      },
    }),

    defineTool({
      name: "fs.read",
      description: "读取已登记项目内的文本文件（路径相对项目根或绝对但不得越界）",
      parameters: Type.Object({
        project: Type.String({ description: "项目 ID、名称或路径" }),
        path: Type.String(),
      }),
      risk: "safe",
      execute: async ({ project, path }) => fsRead(projectRoot(project), path),
    }),
    defineTool({
      name: "fs.write",
      description: "写入项目内文件（覆盖），需审批",
      parameters: Type.Object({
        project: Type.String(),
        path: Type.String(),
        content: Type.String(),
      }),
      risk: "confirm",
      describeApproval: ({ project, path, content }) => ({
        title: `写入文件 ${path}`,
        detail: `项目：${project}\n长度：${content.length} 字符\n预览：\n${content.slice(0, 800)}`,
      }),
      execute: async ({ project, path, content }) => fsWrite(projectRoot(project), path, content),
    }),
    defineTool({
      name: "fs.patch",
      description: "在项目文件中把 oldText 替换为 newText（可多处）",
      parameters: Type.Object({
        project: Type.String(),
        path: Type.String(),
        oldText: Type.String(),
        newText: Type.String(),
      }),
      risk: "confirm",
      describeApproval: ({ project, path, oldText, newText }) => ({
        title: `修补文件 ${path}`,
        detail: `项目：${project}\n- 旧：\n${oldText.slice(0, 400)}\n+ 新：\n${newText.slice(0, 400)}`,
      }),
      execute: async ({ project, path, oldText, newText }) =>
        fsPatch(projectRoot(project), path, oldText, newText),
    }),
    defineTool({
      name: "fs.glob",
      description: "在项目内按 glob/子串列出文件路径",
      parameters: Type.Object({
        project: Type.String(),
        pattern: Type.String(),
        max: Type.Optional(Type.Number()),
      }),
      risk: "safe",
      execute: async ({ project, pattern, max }) => ({
        files: await fsGlob(projectRoot(project), pattern, max ?? 80),
      }),
    }),
    defineTool({
      name: "fs.search",
      description: "在项目源码中搜索包含关键字的行",
      parameters: Type.Object({
        project: Type.String(),
        query: Type.String(),
        glob: Type.Optional(Type.String()),
      }),
      risk: "safe",
      execute: async ({ project, query, glob }) => ({
        hits: await fsSearch(projectRoot(project), query, glob),
      }),
    }),
  );

  registry.register(
    defineTool({
      name: "memory.store",
      description: "把用户明确要求记住的偏好、事实或决定写入长期记忆。用户说「记住」时调用。",
      parameters: Type.Object({
        text: Type.String({ description: "要记住的一句话" }),
        kind: Type.Union([
          Type.Literal("preference"),
          Type.Literal("fact"),
          Type.Literal("decision"),
        ]),
      }),
      risk: "safe",
      execute: async ({ text, kind }) => memory.store({ text, kind, source: "tool" }),
    }),
    defineTool({
      name: "memory.recall",
      description: "按问题检索长期记忆，返回相关的偏好、事实和决定",
      parameters: Type.Object({
        query: Type.String({ description: "用来召回的问题或关键词" }),
        limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 5" })),
      }),
      risk: "safe",
      execute: async ({ query, limit }) => ({
        memories: memory.recall(query, { limit: limit ?? 5 }),
      }),
    }),
    defineTool({
      name: "memory.forget",
      description: "删除一条长期记忆。用户说「忘掉」时，先 memory.recall 找到 id，再调用本工具。",
      parameters: Type.Object({
        id: Type.String({ description: "记忆 id" }),
      }),
      risk: "confirm",
      describeApproval: ({ id }) => ({
        title: "删除长期记忆",
        detail: memory.get(id)?.text ?? id,
      }),
      execute: async ({ id }) => memory.forget(id),
    }),
  );

  registry.register(
    defineTool({
      name: "disk.status",
      description:
        "查看本机用户目录所在磁盘的总容量、剩余空间，以及是否低于清理提醒阈值。只读，不扫描文件。",
      parameters: Type.Object({}),
      risk: "safe",
      execute: async () => disk.status(),
    }),
    defineTool({
      name: "disk.scan",
      description:
        "扫描可重建缓存、开发工具缓存和下载/桌面/文稿里的大文件。不会删除任何文件。返回档位 primary（可清理）、optional（需用户决定）、keep（不清理）。",
      parameters: Type.Object({}),
      risk: "safe",
      execute: async () => {
        const scan = await disk.scan();
        return {
          id: scan.id,
          summary: scan.summary,
          freeBytes: scan.status.freeBytes,
          low: scan.status.low,
          primaryBytes: scan.primaryBytes,
          optionalBytes: scan.optionalBytes,
          items: scan.items.slice(0, 40).map((item) => ({
            id: item.id,
            title: item.title,
            tier: item.tier,
            bytes: item.bytes,
            path: item.path,
            reason: item.reason,
            selectable: item.selectable,
          })),
        };
      },
    }),
    defineTool({
      name: "disk.clean",
      description:
        "清理本次扫描中用户同意的项目。只能传 disk.scan 返回的 id，keep 会被跳过。不要用 shell 删除缓存或用户文件。",
      parameters: Type.Object({
        ids: Type.Array(Type.String({ description: "disk.scan 返回的 id" }), {
          description: "要清理的项目 id",
        }),
      }),
      risk: "confirm",
      describeApproval: ({ ids }) => ({
        title: "清理磁盘",
        detail: disk.describeClean(ids),
      }),
      execute: async ({ ids }) => disk.cleanLatest(ids),
    }),
  );

  registry.register(
    defineTool({
      name: "tasks.ask_user",
      description: "当需要用户进一步澄清或提供缺失信息时调用，会阻塞当前任务直到用户回答",
      parameters: Type.Object({
        question: Type.String({ description: "需要用户回答的问题" }),
      }),
      risk: "confirm",
      describeApproval: ({ question }) => ({
        title: "需要你补充信息",
        detail: question,
      }),
      execute: async ({ question }, ctx) => {
        if (!ctx.requestAnswer) throw new Error("当前上下文不支持追问");
        return ctx.requestAnswer({
          title: "需要你补充信息",
          detail: question,
          risk: "confirm",
          payload: { kind: "question", question },
        });
      },
    }),
    defineTool({
      name: "tasks.submit_plan",
      description:
        "提交本次任务的执行方案（需求理解与分步计划），不执行任何有副作用的操作。只在方案关口场景下可用。",
      parameters: Type.Object({
        summary: Type.String({ description: "方案摘要：要做什么、为什么这么做" }),
        steps: Type.Array(Type.String(), { description: "具体执行步骤，按顺序列出" }),
      }),
      risk: "safe",
      execute: async ({ summary, steps }, ctx) => {
        if (!ctx.recordArtifact) throw new Error("当前上下文不支持提交方案");
        const content = [summary, "", ...steps.map((step, i) => `${i + 1}. ${step}`)].join("\n");
        const artifact = ctx.recordArtifact({
          kind: "plan",
          title: summary.slice(0, 60) || "方案",
          content,
        });
        return `方案已记录（版本 ${artifact.version}）`;
      },
    }),
  );
  return registry;
}
