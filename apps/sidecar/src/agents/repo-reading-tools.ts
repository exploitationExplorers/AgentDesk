import { z } from "zod";
import { Type, defineTool, type AgentDefinition, type ToolRegistry } from "@agentdesk/agent-core";
import { type RepoReadingService, routeInput, sliceInput } from "../services/repo-reading/service";

const session = Type.String({ minLength: 1, maxLength: 80 });
const path = Type.String({ minLength: 1, maxLength: 500 });
const offset = Type.Optional(Type.Integer({ minimum: 0, maximum: 15_000 }));
const idSchema = z.string().min(1).max(80);
const pathSchema = z.string().min(1).max(500);

// restrictsToolsTo 使用精确工具名；不把注册表的命名空间通配符当作执行权限。
export const READING_TOOLS = [
  "reading.list",
  "reading.open",
  "reading.files",
  "reading.read",
  "reading.search",
  "reading.plan",
  "reading.slice",
  "reading.slices",
  "reading.focus",
  "reading.ask",
  "reading.summary",
  "reading.history",
  "projects.list",
  "tasks.ask_user",
];

/** 在组合入口补充能力，避免导读提示和自动化 Agent 的指令互相覆盖。 */
export function withRepoReading(agents: AgentDefinition[]): AgentDefinition[] {
  return agents.map((agent) =>
    ["orchestrator", "code"].includes(agent.name)
      ? {
          ...agent,
          tools: [...agent.tools, "reading.*"],
          systemPrompt: `${agent.systemPrompt}\n\n用户要求读懂仓库源码、逐段讲解代码或继续导读时，先 skills.load repo-walkthrough，直接使用 reading 工具处理。源码导读优先于一般技术介绍路由，不委派给只读网页的 research。普通技术资讯和修改代码请求仍按原规则处理。阅读进度用 reading.list / reading.focus 恢复，不依赖主聊天的旧上下文。`,
        }
      : agent,
  );
}

export function registerRepoReadingTools(
  registry: ToolRegistry,
  reading: RepoReadingService,
): void {
  registry.register(
    defineTool({
      name: "reading.list",
      description: "列出最近 20 次源码导读，恢复阅读前先确认项目和会话。",
      parameters: Type.Object({}),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async () => reading.list(),
    }),
    defineTool({
      name: "reading.open",
      description:
        "创建源码导读：target 为已登记项目的 ID、准确名称、本地路径或公开 GitHub 仓库首页。只读取源码并保存导读进度；GitHub 固定到当前 commit，不 clone、不运行项目。继续阅读用 list/focus。",
      parameters: Type.Object({ target: Type.String({ minLength: 1, maxLength: 1000 }) }),
      risk: "safe",
      isConcurrencySafe: false,
      execute: async (args, ctx) =>
        reading.open(z.string().trim().min(1).max(1000).parse(args.target), ctx.signal),
      restrictsToolsTo: () => READING_TOOLS,
    }),
    defineTool({
      name: "reading.files",
      description:
        "分页列出可阅读源码文件，prefix 可定位 monorepo 子包；nextOffset 非空需继续，truncated 时不能声称已遍历全部。",
      parameters: Type.Object({
        sessionId: session,
        prefix: Type.Optional(Type.String({ maxLength: 500 })),
        offset,
      }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args, ctx) => {
        const value = z
          .object({
            sessionId: idSchema,
            prefix: z.string().max(500).default(""),
            offset: z.number().int().min(0).max(15_000).default(0),
          })
          .parse(args);
        return reading.files(value.sessionId, value.prefix, value.offset, ctx.signal);
      },
    }),
    defineTool({
      name: "reading.read",
      description:
        "按范围读取源码，返回真实行号、完整文件 hash 与 nextLine。每次最多 160 行、10000 字符；partialLine 表示单行过长。",
      parameters: Type.Object({
        sessionId: session,
        path,
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args, ctx) => {
        const value = z
          .object({
            sessionId: idSchema,
            path: pathSchema,
            startLine: z.number().int().positive().default(1),
            endLine: z.number().int().positive().optional(),
          })
          .parse(args);
        return reading.read(
          value.sessionId,
          value.path,
          value.startLine,
          value.endLine,
          ctx.signal,
        );
      },
    }),
    defineTool({
      name: "reading.search",
      description:
        "搜索源码中的函数定义或调用点，返回文件和行号。用 prefix 缩小范围；nextOffset 非空表示还有文件未搜索。",
      parameters: Type.Object({
        sessionId: session,
        query: Type.String({ minLength: 1, maxLength: 200 }),
        prefix: Type.Optional(Type.String({ maxLength: 500 })),
        offset,
      }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args, ctx) => {
        const value = z
          .object({
            sessionId: idSchema,
            query: z.string().trim().min(1).max(200),
            prefix: z.string().max(500).default(""),
            offset: z.number().int().min(0).max(15_000).default(0),
          })
          .parse(args);
        return reading.search(value.sessionId, value.query, value.prefix, value.offset, ctx.signal);
      },
    }),
    defineTool({
      name: "reading.plan",
      description: "保存已核实的项目概览和最多 12 个文件的阅读路线。路线必须引用实际存在的文件。",
      parameters: Type.Object({
        sessionId: session,
        overview: Type.String({ minLength: 1, maxLength: 4000 }),
        route: Type.Array(
          Type.Object({ path, reason: Type.String({ minLength: 1, maxLength: 200 }) }),
          { minItems: 1, maxItems: 12 },
        ),
      }),
      risk: "safe",
      isConcurrencySafe: false,
      execute: async (args, ctx) => {
        const value = z
          .object({
            sessionId: idSchema,
            overview: z.string().min(1).max(4000),
            route: z.array(routeInput).min(1).max(12),
          })
          .parse(args);
        const result = await reading.plan(value.sessionId, value.overview, value.route, ctx.signal);
        ctx.recordArtifact?.({
          kind: "file",
          title: `${result.name} 源码导读`,
          artifactKey: `reading:${value.sessionId}:plan`,
          mimeType: "text/markdown",
          content: `${value.overview}\n\n${value.route.map((item, i) => `${i + 1}. ${item.path}：${item.reason}`).join("\n")}`,
        });
        return result;
      },
    }),
    defineTool({
      name: "reading.slice",
      description:
        "为文件建立阅读片段。读完源码后传 hash 和 slices 生成逻辑分段；不传 slices 时明确按行暂分。重分段会归档旧进度和问答。",
      parameters: Type.Object({
        sessionId: session,
        path,
        expectedHash: Type.Optional(Type.String()),
        slices: Type.Optional(
          Type.Array(
            Type.Object({
              startLine: Type.Integer({ minimum: 1 }),
              endLine: Type.Integer({ minimum: 1 }),
              title: Type.String({ minLength: 1, maxLength: 100 }),
              role: Type.Optional(Type.String({ maxLength: 200 })),
            }),
            { minItems: 1, maxItems: 200 },
          ),
        ),
      }),
      risk: "safe",
      isConcurrencySafe: false,
      execute: async (args, ctx) => {
        const value = z
          .object({
            sessionId: idSchema,
            path: pathSchema,
            expectedHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            slices: z.array(sliceInput).min(1).max(200).optional(),
          })
          .parse(args);
        return reading.slice(
          value.sessionId,
          value.path,
          value.expectedHash,
          value.slices,
          ctx.signal,
        );
      },
    }),
    defineTool({
      name: "reading.slices",
      description: "分页查看某个文件已有的片段目录、行号、状态和 ID。",
      parameters: Type.Object({ sessionId: session, path, offset }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args) => {
        const value = z
          .object({
            sessionId: idSchema,
            path: pathSchema,
            offset: z.number().int().min(0).max(15_000).default(0),
          })
          .parse(args);
        return reading.slices(value.sessionId, value.path, value.offset);
      },
    }),
    defineTool({
      name: "reading.focus",
      description:
        "恢复当前阅读进度或切换到指定 sliceId，同时校验源码版本。只有用户明确表示读懂该段时才设 markDone=true，并传该段 ID。",
      parameters: Type.Object({
        sessionId: session,
        sliceId: Type.Optional(session),
        markDone: Type.Optional(Type.Boolean()),
      }),
      risk: "safe",
      isConcurrencySafe: false,
      execute: async (args, ctx) => {
        const value = z
          .object({
            sessionId: idSchema,
            sliceId: idSchema.optional(),
            markDone: z.boolean().default(false),
          })
          .parse(args);
        return reading.focus(value.sessionId, value.sliceId, value.markDone, ctx.signal);
      },
      restrictsToolsTo: () => READING_TOOLS,
    }),
    defineTool({
      name: "reading.ask",
      description:
        "在当前片段的独立问答中讲解或追问。使用已配置的 code 模型，只能读取和搜索此仓库，自动保存本段问答；不同片段的对话互不混入。",
      parameters: Type.Object({
        sessionId: session,
        question: Type.String({ minLength: 1, maxLength: 2000 }),
        detail: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("deep")])),
      }),
      risk: "safe",
      isConcurrencySafe: false,
      execute: async (args, ctx) => {
        const value = z
          .object({
            sessionId: idSchema,
            question: z.string().trim().min(1).max(2000),
            detail: z.enum(["brief", "deep"]).default("brief"),
          })
          .parse(args);
        return reading.ask(value.sessionId, value.question, value.detail, ctx);
      },
    }),
    defineTool({
      name: "reading.history",
      description:
        "分页读取当前会话的历史问答，包括重分段前归档的问答；可按文件过滤。archived=true 时引用的是旧切片。",
      parameters: Type.Object({ sessionId: session, path: Type.Optional(path), offset }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args) => {
        const value = z
          .object({
            sessionId: idSchema,
            path: pathSchema.optional(),
            offset: z.number().int().min(0).max(15_000).default(0),
          })
          .parse(args);
        return reading.historyPage(value.sessionId, value.path, value.offset);
      },
    }),
    defineTool({
      name: "reading.summary",
      description:
        "获取各段阅读状态和问答摘要，供生成复习总结。stale 表示源码已变化，truncated 表示摘要不完整；未读段不能宣称读懂。",
      parameters: Type.Object({ sessionId: session }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args, ctx) => reading.summary(idSchema.parse(args.sessionId), ctx.signal),
    }),
  );
}
