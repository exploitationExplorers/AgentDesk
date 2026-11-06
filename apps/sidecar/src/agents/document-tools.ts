import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { z } from "zod";
import { defineTool, Type, type ToolContext, type ToolRegistry } from "@agentdesk/agent-core";
import { draftScope } from "../services/draft-scope";

const sectionSchema = z.object({
  heading: z.string().trim().min(1).max(120),
  paragraphs: z.array(z.string().min(1).max(4000)).min(1).max(8),
});
const draftSchema = z.object({
  title: z.string().trim().min(1).max(80),
  total: z.number().int().min(1).max(20),
  sections: z.array(sectionSchema).max(20),
  previewId: z.string().optional(),
});
type Draft = z.infer<typeof draftSchema>;

export function registerDocumentTools(registry: ToolRegistry, root: string): void {
  const scopes = new WeakMap<NonNullable<ToolContext["recordArtifact"]>, Map<string, Draft>>();
  const scope = (ctx: ToolContext) => draftScope(ctx, scopes, "document-drafts:v1", draftSchema);
  registry.register(
    defineTool({
      name: "documents.start",
      description:
        "开始撰写 Word 文档，指定标题和章节数，右侧立即打开文档预览。然后 append 分段交付，最后 finish 保存 Word 文件。",
      risk: "safe",
      isConcurrencySafe: false,
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 80 }),
        total: Type.Integer({ minimum: 1, maximum: 20 }),
      }),
      execute: async (input, ctx) => {
        const data = z
          .object({
            title: z.string().trim().min(1).max(80),
            total: z.number().int().min(1).max(20),
          })
          .parse(input);
        const map = scope(ctx);
        if (map.size >= 4) throw new Error("请先完成已有文档");
        const draftId = randomUUID();
        map.set(draftId, { ...data, sections: [] });
        ctx.emit({
          type: "document_preview",
          title: data.title,
          content: "",
          completed: 0,
          total: data.total,
        });
        return { draftId, nextAfterSection: 0, total: data.total };
      },
    }),
    defineTool({
      name: "documents.append",
      description:
        "撰写并预览下一批章节，每次 1—3 个。afterSection 使用上次返回的 nextAfterSection。段落提供纯文本，客户端负责文档排版。",
      risk: "safe",
      isConcurrencySafe: false,
      parameters: Type.Object({
        draftId: Type.String(),
        afterSection: Type.Integer({ minimum: 0 }),
        sections: Type.Array(
          Type.Object({
            heading: Type.String({ minLength: 1, maxLength: 120 }),
            paragraphs: Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), {
              minItems: 1,
              maxItems: 8,
            }),
          }),
          { minItems: 1, maxItems: 3 },
        ),
      }),
      execute: async (input, ctx) => {
        const args = z
          .object({
            draftId: z.string(),
            afterSection: z.number().int().min(0),
            sections: z.array(sectionSchema).min(1).max(3),
          })
          .parse(input);
        const draft = scope(ctx).get(args.draftId);
        if (!draft) throw new Error("当前运行中没有该文档草稿");
        if (args.afterSection !== draft.sections.length)
          throw new Error(`已完成 ${draft.sections.length} 章，请核对后继续，勿重复添加`);
        const sections = [...draft.sections, ...args.sections];
        if (sections.length > draft.total) throw new Error("章节数超过计划范围");
        const content = `# ${draft.title}\n\n${sections.map((section) => `## ${section.heading}\n\n${section.paragraphs.join("\n\n")}`).join("\n\n")}`;
        if (content.length > 80_000) throw new Error("文档过长，请拆分为多份文档");
        const artifact = ctx.recordArtifact!({
          kind: "file",
          title: draft.title,
          artifactKey: `document:${draft.title}`,
          mimeType: "text/markdown",
          content,
          metadata: {
            format: "document",
            status: "draft",
            sectionCount: sections.length,
            total: draft.total,
          },
        });
        scope(ctx).set(args.draftId, { ...draft, sections, previewId: artifact.id });
        ctx.emit({
          type: "document_preview",
          title: draft.title,
          content,
          completed: sections.length,
          total: draft.total,
        });
        return {
          draftId: args.draftId,
          nextAfterSection: sections.length,
          total: draft.total,
          artifactId: artifact.id,
        };
      },
    }),
    defineTool({
      name: "documents.finish",
      description: "章节全部完成后生成可编辑 Word 文件，保留文档预览。",
      risk: "safe",
      isConcurrencySafe: false,
      parameters: Type.Object({ draftId: Type.String() }),
      execute: async ({ draftId }, ctx) => {
        const map = scope(ctx);
        const draft = map.get(draftId);
        if (!draft || !draft.previewId) throw new Error("当前运行中没有可保存的文档");
        if (draft.sections.length !== draft.total) throw new Error("章节尚未完成，请继续撰写");
        const document = new Document({
          title: draft.title,
          creator: "AgentDesk",
          sections: [
            {
              children: [
                new Paragraph({ text: draft.title, heading: HeadingLevel.TITLE }),
                ...draft.sections.flatMap((section) => [
                  new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }),
                  ...section.paragraphs.map(
                    (text) => new Paragraph({ text, spacing: { after: 180 } }),
                  ),
                ]),
              ],
            },
          ],
        });
        const bytes = await Packer.toBuffer(document);
        ctx.signal?.throwIfAborted();
        const title =
          [...draft.title]
            .map((char) => (char.codePointAt(0)! < 32 || /[<>:"/\\|?*]/.test(char) ? "_" : char))
            .join("")
            .replace(/[. ]+$/g, "") || "文档";
        const folder = randomUUID();
        await mkdir(join(root, folder), { recursive: true });
        const filePath = join(folder, `${title}.docx`);
        await writeFile(join(root, filePath), bytes, { flag: "wx" });
        ctx.signal?.throwIfAborted();
        const artifact = ctx.recordArtifact!({
          kind: "file",
          title: `${title}.docx`,
          artifactKey: `document:${draft.title}`,
          filePath,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          metadata: {
            storage: "generated",
            previewArtifactId: draft.previewId,
            sectionCount: draft.sections.length,
            sizeBytes: bytes.length,
          },
        });
        map.delete(draftId);
        return {
          artifactId: artifact.id,
          title: `${title}.docx`,
          message: "Word 文档已保存，可以预览和下载。",
        };
      },
    }),
  );
}
