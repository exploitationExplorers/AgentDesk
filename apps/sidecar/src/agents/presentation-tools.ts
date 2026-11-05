import { defineTool, Type, type ToolRegistry } from "@agentdesk/agent-core";
import { createPresentation } from "../services/presentations";
import { PresentationDrafts } from "../services/presentation-drafts";

export function registerPresentationTools(registry: ToolRegistry, root: string): void {
  const drafts = new PresentationDrafts(root);
  registry.register(
    defineTool({
      name: "presentations.start",
      description:
        "开始分阶段制作 PPT。先确定标题、配色和页数，右侧立即打开生成面板。后续用 append 每次交付 1—6 页，最后 finish 导出。",
      risk: "safe",
      isConcurrencySafe: false,
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 80 }),
        theme: Type.Optional(
          Type.Union([Type.Literal("blue"), Type.Literal("dark"), Type.Literal("warm")]),
        ),
        total: Type.Integer({ minimum: 1, maximum: 30 }),
      }),
      execute: async (args, ctx) => drafts.start(args, ctx),
    }),
    defineTool({
      name: "presentations.append",
      description:
        "向当前 PPT 草稿添加 1—6 页并立刻展示，推荐每次 2—3 页。afterSlide 使用上次返回的 nextAfterSlide；不能跨运行引用草稿。",
      risk: "safe",
      isConcurrencySafe: false,
      parameters: Type.Object({
        draftId: Type.String(),
        afterSlide: Type.Integer({ minimum: 0 }),
        slides: Type.Array(
          Type.Object({
            title: Type.String({ minLength: 1, maxLength: 60 }),
            subtitle: Type.Optional(Type.String({ maxLength: 100 })),
            bullets: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 4 }),
            ),
            notes: Type.Optional(Type.String({ maxLength: 2000 })),
          }),
          { minItems: 1, maxItems: 6 },
        ),
      }),
      execute: (args, ctx) => drafts.append(args, ctx),
    }),
    defineTool({
      name: "presentations.finish",
      description: "所有页面完成后保存可编辑 PPT 和预览，返回可下载成果。",
      risk: "safe",
      isConcurrencySafe: false,
      parameters: Type.Object({ draftId: Type.String() }),
      execute: ({ draftId }, ctx) => drafts.finish(draftId, ctx),
    }),
  );
  registry.register(
    defineTool({
      name: "presentations.create",
      description:
        "生成可编辑的 PowerPoint 演示文稿，同时提供逐页预览与下载。只在应用成果目录创建新文件，无需安装工具或运行命令。内容超过单页限制时拆页。示例数据必须标明为示例。",
      risk: "safe",
      isConcurrencySafe: false,
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 80 }),
        theme: Type.Optional(
          Type.Union([Type.Literal("blue"), Type.Literal("dark"), Type.Literal("warm")]),
        ),
        slides: Type.Array(
          Type.Object({
            title: Type.String({ minLength: 1, maxLength: 60 }),
            subtitle: Type.Optional(Type.String({ maxLength: 100 })),
            bullets: Type.Optional(
              Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 4 }),
            ),
            notes: Type.Optional(Type.String({ maxLength: 2000 })),
          }),
          { minItems: 1, maxItems: 30 },
        ),
      }),
      execute: (input, ctx) => createPresentation(root, input, ctx),
    }),
  );
}
