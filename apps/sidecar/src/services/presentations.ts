import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import PptxGenJS from "pptxgenjs";
import { z } from "zod";
import type { ToolContext } from "@agentdesk/agent-core";

export const slideSchema = z.object({
  title: z.string().trim().min(1).max(60),
  subtitle: z.string().max(100).optional(),
  bullets: z.array(z.string().min(1).max(100)).max(4).default([]),
  notes: z.string().max(2000).optional(),
});
export const presentationInput = z.object({
  title: z.string().trim().min(1).max(80),
  theme: z.enum(["blue", "dark", "warm"]).default("blue"),
  slides: z.array(slideSchema).min(1).max(30),
});

const palettes = {
  blue: { background: "F5F7FB", ink: "17263C", accent: "426BC2", muted: "55657D" },
  dark: { background: "17263C", ink: "F6F8FC", accent: "8FB8FF", muted: "C4CFDF" },
  warm: { background: "FBF7F1", ink: "352E28", accent: "B2633B", muted: "79685D" },
};
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );

/** 与 PPT 使用相同换行和坐标，预览不依赖外部文档服务。 */
function lines(text: string, maxWidth: number): string[] {
  const output: string[] = [];
  let line = "";
  let width = 0;
  for (const char of text.replace(/\s+/g, " ")) {
    const size = char.codePointAt(0)! < 256 ? 0.55 : 1;
    if (char === "\n" || width + size > maxWidth) {
      output.push(line);
      line = "";
      width = 0;
      if (char === "\n") continue;
    }
    line += char;
    width += size;
  }
  if (line) output.push(line);
  return output;
}

export async function renderPresentation(
  input: unknown,
  ctx: ToolContext,
  total?: number,
  presentationId?: string,
) {
  const deck = presentationInput.parse(input);
  ctx.signal?.throwIfAborted();
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title;
  pptx.author = "AgentDesk";
  pptx.subject = deck.title;
  pptx.theme = { headFontFace: "Microsoft YaHei", bodyFontFace: "Microsoft YaHei" };
  const palette = palettes[deck.theme];
  const pages: string[] = [];
  ctx.emit({
    type: "presentation_status",
    phase: "rendering",
    message: "正在制作演示文稿",
    presentationId,
    deckTitle: deck.title,
  });
  for (const [index, item] of deck.slides.entries()) {
    ctx.signal?.throwIfAborted();
    const slide = pptx.addSlide();
    slide.background = { color: palette.background };
    const svg: string[] = [`<rect width="1280" height="720" fill="#${palette.background}"/>`];
    const text = (
      value: string,
      x: number,
      y: number,
      width: number,
      fontSize: number,
      color: string,
      bold = false,
    ) => {
      const wrapped = lines(value, (width * 72) / fontSize);
      const lineHeight = fontSize * 1.35;
      wrapped.forEach((line, row) => {
        slide.addText(line, {
          x,
          y: y + (row * lineHeight) / 72,
          w: width,
          h: lineHeight / 72,
          fontFace: "Microsoft YaHei",
          fontSize,
          bold,
          color,
          margin: 0,
          breakLine: false,
          valign: "top",
        });
        svg.push(
          `<text x="${x * 96}" y="${y * 96 + (row * lineHeight * 4) / 3}" fill="#${color}" font-family="Microsoft YaHei,Arial,sans-serif" font-size="${(fontSize * 4) / 3}" font-weight="${bold ? 700 : 400}" dominant-baseline="text-before-edge">${escape(line)}</text>`,
        );
      });
    };
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.65,
      y: 0.55,
      w: 0.65,
      h: 0.06,
      line: { transparency: 100 },
      fill: { color: palette.accent },
    });
    svg.push(`<rect x="62.4" y="52.8" width="62.4" height="5.76" fill="#${palette.accent}"/>`);
    const cover = index === 0 && item.bullets.length <= 2;
    let titleSize = cover ? 48 : 30;
    while (
      (lines(item.title, (12 * 72) / titleSize).length * titleSize * 1.35) / 72 >
      (cover ? 1.25 : 1.1)
    )
      titleSize -= 1;
    text(item.title, 0.65, cover ? 1.35 : 0.85, 12, titleSize, palette.ink, true);
    if (item.subtitle)
      text(item.subtitle, 0.65, cover ? 2.75 : 2.05, 12, cover ? 18 : 16, palette.muted);
    item.bullets.forEach((bullet, i) => {
      const y = (cover ? 4.2 : 2.9) + i * (cover ? 0.85 : 1.08);
      text(String(i + 1).padStart(2, "0"), 0.65, y, 0.6, cover ? 17 : 18, palette.accent, true);
      text(bullet, 1.45, y, 11, bullet.length > 55 ? 15 : 18, palette.ink);
    });
    text(`${index + 1} / ${total ?? deck.slides.length}`, 11.4, 6.95, 1.2, 10, palette.muted);
    if (item.notes) slide.addNotes(item.notes);
    const slideSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" role="img" aria-label="${escape(item.title)}">${svg.join("")}</svg>`;
    pages.push(
      `<section data-slide="${index + 1}" aria-label="${escape(item.title)}">${slideSvg}</section>`,
    );
    ctx.emit({
      type: "presentation_slide",
      title: item.title,
      index: index + 1,
      total: total ?? deck.slides.length,
      svg: slideSvg,
      deckTitle: deck.title,
      presentationId,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { pptx, deck, pages };
}

export async function createPresentation(
  root: string,
  input: unknown,
  ctx: ToolContext,
  draftId?: string,
) {
  if (!ctx.recordArtifact) throw new Error("当前任务不支持保存成果");
  const data = presentationInput.parse(input);
  ctx.signal?.throwIfAborted();
  const presentationId = draftId ?? randomUUID();
  if (!draftId)
    ctx.emit({
      type: "presentation_status",
      phase: "starting",
      message: "正在准备演示文稿",
      presentationId,
      deckTitle: data.title,
    });
  const { pptx, deck, pages } = await renderPresentation(data, ctx, undefined, presentationId);
  ctx.emit({
    type: "presentation_status",
    phase: "saving",
    message: "正在保存演示文稿",
    presentationId,
    deckTitle: deck.title,
  });
  const bytes = (await pptx.write({ outputType: "nodebuffer", compression: true })) as Buffer;
  ctx.signal?.throwIfAborted();
  const folder = randomUUID();
  const safeTitle = [...deck.title]
    .map((char) => (char.codePointAt(0)! < 32 ? "_" : char))
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "");
  const filename = `${safeTitle || "演示文稿"}.pptx`;
  const relativePath = join(folder, filename);
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, relativePath), bytes, { flag: "wx" });
  ctx.signal?.throwIfAborted();
  const preview = ctx.recordArtifact({
    kind: "file",
    title: `${deck.title}预览`,
    mimeType: "text/html",
    content: `<!doctype html><html><head><style>body{margin:0}svg{display:block;width:100%;height:auto}section{margin-bottom:16px}</style></head><body>${pages.join("")}</body></html>`,
    metadata: { role: "preview", format: "slides" },
  });
  const artifact = ctx.recordArtifact({
    kind: "file",
    title: filename,
    filePath: relativePath,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    artifactKey: `presentation:${deck.title}`,
    metadata: {
      storage: "generated",
      previewArtifactId: preview.id,
      slideCount: deck.slides.length,
      sizeBytes: bytes.length,
    },
  });
  return {
    artifactId: artifact.id,
    title: filename,
    slideCount: deck.slides.length,
    message: "演示文稿已生成，可以在成果面板预览和下载。",
  };
}
