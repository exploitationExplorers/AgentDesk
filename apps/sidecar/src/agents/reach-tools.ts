import { Type, defineTool, type ToolRegistry } from "@agentdesk/agent-core";
import type { ReachService } from "../services/reach";

const limit = Type.Optional(
  Type.Integer({
    minimum: 1,
    maximum: 25,
    description: "最多返回的条目数，默认 10，正文与评论合计",
  }),
);
const channel = Type.String({ minLength: 1, maxLength: 80 });
const target = Type.String({ minLength: 1, maxLength: 4096 });

export function registerReachTools(registry: ToolRegistry, reach: ReachService) {
  registry.register(
    defineTool({
      name: "reach.capabilities",
      description: "查看跨平台检索渠道、动作、启用状态与数据发送对象；不访问网络",
      parameters: Type.Object({}),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async () => reach.capabilities(),
    }),
    defineTool({
      name: "reach.status",
      description: "查看各渠道最近一次调用状态；未调用过不代表已验证可用，不发起网络探测",
      parameters: Type.Object({}),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async () => reach.status(),
    }),
    defineTool({
      name: "reach.search",
      description:
        "搜索全网（web，查询词发送给 Exa 免费端点）或 GitHub 仓库（github）；返回摘要与来源。GitHub 不支持通用代码搜索",
      parameters: Type.Object({
        channel: Type.Optional(channel),
        query: Type.String({ minLength: 1, maxLength: 2000 }),
        limit,
      }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args, ctx) =>
        reach.run({ ...args, channel: args.channel ?? "web", action: "search" }, ctx.signal),
    }),
    defineTool({
      name: "reach.read",
      description:
        "读取网页、GitHub 仓库 README / Issue / PR 讨论或 V2EX 主题与回复。自动识别链接；普通网页本地提取失败时把网址交给 Jina。PR 不含 diff 或逐行 review",
      parameters: Type.Object({ target, channel: Type.Optional(channel), limit }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args, ctx) => reach.read(args.target, args.channel, args.limit, ctx.signal),
    }),
    defineTool({
      name: "reach.query",
      description:
        "执行渠道专用只读动作：V2EX hot（热门）、node（target 为节点名）、user（target 为用户名）。不支持 V2EX 全站搜索",
      parameters: Type.Object({
        channel,
        action: Type.Union([Type.Literal("hot"), Type.Literal("node"), Type.Literal("user")]),
        target: Type.Optional(target),
        limit,
      }),
      risk: "safe",
      isConcurrencySafe: true,
      execute: async (args, ctx) => reach.run(args, ctx.signal),
    }),
  );
}
