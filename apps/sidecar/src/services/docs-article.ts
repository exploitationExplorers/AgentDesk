import { articleCatalog } from "./article-mirrors";
import { fetchPublicSource } from "./public-fetch";

export interface DocsChapter {
  title: string;
  /** 站点上的章节链接。目录节点本身可以没有页面。 */
  url: string | null;
  children: DocsChapter[];
}

export interface ArticleHeading {
  id: string;
  level: number;
  text: string;
}

export interface ArticleCodeTab {
  label: string;
  lang: string;
  code: string;
}

export type ArticleBlock =
  | { kind: "prose"; text: string; headings: ArticleHeading[] }
  | { kind: "code"; tabs: ArticleCodeTab[] };

const NBSP = /&nbsp;/g;

function cleanTitle(value: string): string {
  return value.replace(NBSP, " ").replace(/\s+/g, " ").trim();
}

function headingId(text: string, used: Map<string, number>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "section";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function headingsOf(markdown: string, used: Map<string, number>): ArticleHeading[] {
  return markdown.split("\n").flatMap((line) => {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (!match) return [];
    const text = match[2]!.replace(/[`*]/g, "").trim();
    return [{ id: headingId(text, used), level: match[1]!.length, text }];
  });
}

function tidyProse(markdown: string): string {
  return markdown
    .replace(/<div[\s\S]*?<\/div>/g, "")
    .replace(/!\[[^\]]*]\([^)]+\)(?:\{[^}]*\})?/g, "")
    .replace(/\{[^}\n]*\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 把 MkDocs 正文拆成段落和代码卡片。`=== "Python"` 一组语言合成一张带标签的卡片。 */
export function parseArticle(markdown: string): ArticleBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ArticleBlock[] = [];
  const used = new Map<string, number>();
  let prose: string[] = [];

  const flush = () => {
    const text = tidyProse(prose.join("\n"));
    prose = [];
    if (!text) return;
    blocks.push({ kind: "prose", text, headings: headingsOf(text, used) });
  };

  let index = 0;
  while (index < lines.length) {
    if (/^===\s+"[^"]+"\s*$/.test(lines[index]?.trim() ?? "")) {
      flush();
      const tabs: ArticleCodeTab[] = [];
      while (index < lines.length) {
        while (index < lines.length && lines[index]!.trim() === "") index += 1;
        if (!/^===\s+"[^"]+"\s*$/.test(lines[index]?.trim() ?? "")) break;
        const label = cleanTitle(/^===\s+"([^"]+)"\s*$/.exec(lines[index]!.trim())?.[1] ?? "代码");
        index += 1;
        while (index < lines.length && lines[index]!.trim() === "") index += 1;
        const fence = lines[index] ?? "";
        if (!fence.trim().startsWith("```")) continue;
        const pad = /^ */.exec(fence)?.[0].length ?? 0;
        const lang = fence.trim().slice(3).split(/\s+/)[0] ?? "";
        index += 1;
        const code: string[] = [];
        while (index < lines.length && !lines[index]!.trim().startsWith("```")) {
          code.push(lines[index]!.slice(pad));
          index += 1;
        }
        if (lines[index]?.trim().startsWith("```")) index += 1;
        tabs.push({ label, lang, code: code.join("\n").replace(/\s+$/, "") });
      }
      if (tabs.length) blocks.push({ kind: "code", tabs });
      continue;
    }

    if ((lines[index] ?? "").trim().startsWith("```")) {
      flush();
      const lang = lines[index]!.trim().slice(3).split(/\s+/)[0] ?? "";
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        code.push(lines[index]!);
        index += 1;
      }
      if (lines[index]?.startsWith("```")) index += 1;
      blocks.push({ kind: "code", tabs: [{ label: lang || "代码", lang, code: code.join("\n") }] });
      continue;
    }

    prose.push(lines[index] ?? "");
    index += 1;
  }
  flush();
  return blocks;
}

/** 只解析 MkDocs 的 nav，标题和路径都来自目录文件本身。 */
export function parseMkdocsNav(yaml: string, siteOrigin: string): DocsChapter[] {
  const start = yaml.search(/^nav:\s*$/m);
  if (start < 0) return [];
  const root: DocsChapter = { title: "", url: null, children: [] };
  const stack: Array<{ indent: number; node: DocsChapter }> = [{ indent: -1, node: root }];
  for (const line of yaml.slice(start).split("\n").slice(1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s*-\s+/.test(line)) break;
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    let body = cleanTitle(line.trim().replace(/^- /, ""));
    let path: string | null = null;
    const mapped = /^(.*?):\s+(\S+\.md)$/.exec(body);
    if (mapped) {
      body = mapped[1]!.trim();
      path = mapped[2]!;
    } else if (body.endsWith(".md")) {
      path = body;
      body = path.split("/").pop()!.replace(/\.md$/, "").replace(/[_-]+/g, " ");
    } else if (body.endsWith(":")) {
      body = body.slice(0, -1).trim();
    }
    const node: DocsChapter = {
      title: body,
      url: path ? chapterUrl(siteOrigin, path) : null,
      children: [],
    };
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ indent, node });
  }
  return hoistIndexPages(root.children);
}

/** `index.md` 是章节首页，挂到章标题上，不单独显示成 “index”。 */
function hoistIndexPages(nodes: DocsChapter[]): DocsChapter[] {
  return nodes.map((node) => {
    const children = hoistIndexPages(node.children);
    const landing = children.find(
      (child) => child.title === "index" && child.children.length === 0,
    );
    if (!node.url && landing?.url) {
      return {
        ...node,
        url: landing.url,
        children: children.filter((child) => child !== landing),
      };
    }
    return { ...node, children };
  });
}

export function chapterUrl(siteOrigin: string, path: string): string {
  const page = path.replace(/\.md$/, "").replace(/\/index$/, "");
  return `${siteOrigin.replace(/\/$/, "")}/${page}/`;
}

export async function readDocsOutline(
  pageUrl: string,
  signal?: AbortSignal,
): Promise<DocsChapter[]> {
  const catalog = articleCatalog(pageUrl);
  if (!catalog) return [];
  const response = await fetchPublicSource(catalog.catalog, {
    signal,
    headers: { Accept: "text/plain,text/yaml,*/*" },
  });
  if (response.status >= 400) return [];
  return parseMkdocsNav(response.text, catalog.siteOrigin);
}
