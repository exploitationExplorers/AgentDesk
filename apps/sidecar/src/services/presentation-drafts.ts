import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "@agentdesk/agent-core";
import { createPresentation, renderPresentation, slideSchema } from "./presentations";
import { draftScope } from "./draft-scope";

const startInput = z.object({
  title: z.string().trim().min(1).max(80),
  theme: z.enum(["blue", "dark", "warm"]).default("blue"),
  total: z.number().int().min(1).max(30),
});
const draftSchema = startInput.extend({ slides: z.array(slideSchema).max(30) });
type Draft = z.infer<typeof draftSchema>;

/** 自动化草稿由宿主按任务保存，普通聊天仍按本轮写入回调隔离。 */
export class PresentationDrafts {
  private readonly scopes = new WeakMap<
    NonNullable<ToolContext["recordArtifact"]>,
    Map<string, Draft>
  >();
  constructor(private readonly root: string) {}

  private scope(ctx: ToolContext) {
    return draftScope(ctx, this.scopes, "presentation-drafts:v1", draftSchema);
  }

  start(input: unknown, ctx: ToolContext) {
    const data = startInput.parse(input);
    const scope = this.scope(ctx);
    if (scope.size >= 4) throw new Error("请先完成已有演示文稿");
    const id = randomUUID();
    scope.set(id, { ...data, slides: [] });
    ctx.emit({
      type: "presentation_status",
      phase: "starting",
      message: `正在制作《${data.title}》`,
      presentationId: id,
      deckTitle: data.title,
    });
    return { draftId: id, nextAfterSlide: 0, total: data.total };
  }

  async append(input: unknown, ctx: ToolContext) {
    const args = z
      .object({
        draftId: z.string(),
        afterSlide: z.number().int().min(0),
        slides: z.array(slideSchema).min(1).max(6),
      })
      .parse(input);
    const draft = this.scope(ctx).get(args.draftId);
    if (!draft) throw new Error("当前运行中没有该草稿，请重新创建");
    if (args.afterSlide !== draft.slides.length)
      throw new Error(`已完成 ${draft.slides.length} 页，请核对后继续，勿重复添加`);
    if (draft.slides.length + args.slides.length > draft.total)
      throw new Error("新增页面超过计划页数");
    const next = { ...draft, slides: [...draft.slides, ...args.slides] };
    const { pages } = await renderPresentation(next, ctx, draft.total, args.draftId);
    ctx.signal?.throwIfAborted();
    const artifact = ctx.recordArtifact!({
      kind: "file",
      title: draft.title,
      artifactKey: `presentation:${draft.title}`,
      mimeType: "text/html",
      content: `<!doctype html><html><head><style>body{margin:0}svg{display:block;width:100%}</style></head><body>${pages.join("")}</body></html>`,
      metadata: {
        format: "slides",
        status: "draft",
        slideCount: next.slides.length,
        total: draft.total,
      },
    });
    this.scope(ctx).set(args.draftId, next);
    return {
      draftId: args.draftId,
      nextAfterSlide: next.slides.length,
      total: draft.total,
      artifactId: artifact.id,
      message: "新页面已展示，继续撰写后续页面。全部页面完成后调用 presentations.finish。",
    };
  }

  async finish(draftId: string, ctx: ToolContext) {
    const scope = this.scope(ctx);
    const draft = scope.get(draftId);
    if (!draft) throw new Error("当前运行中没有该草稿");
    if (draft.slides.length !== draft.total)
      throw new Error(`目前完成 ${draft.slides.length}/${draft.total} 页，请补齐内容`);
    const result = await createPresentation(this.root, draft, ctx, draftId);
    scope.delete(draftId);
    return result;
  }
}
