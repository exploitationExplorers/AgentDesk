import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { fsRead } from "@agentdesk/integrations";
import { AppError, ErrorCode } from "@agentdesk/shared";
import type { ProjectService } from "../projects";
import { fetchPublicSource } from "../public-fetch";
export type ReadingSource =
  | {
      kind: "local";
      projectId: string;
      root: string;
      name: string;
    }
  | {
      kind: "github";
      owner: string;
      repo: string;
      commit: string;
      name: string;
      files: string[];
      truncated: boolean;
    };
const OMIT = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
]);
const TEXT =
  /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|bash|json|ya?ml|toml|xml|md|txt|css|scss|html|sql|proto)$/i;
const MAX_FILES = 3000;
const MAX_BYTES = 512000;
export function readingPath(input: string): string {
  const path = input.replaceAll("\\", "/");
  if (
    !path ||
    path.length > 500 ||
    path.includes(":") ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  ) {
    throw new AppError(ErrorCode.BadRequest, "请提供仓库内的相对文件路径");
  }
  return path;
}
function readable(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1)!;
  return (
    !parts.some(
      (p) =>
        OMIT.has(p) ||
        (p.startsWith(".") && ![".github", ".gitignore", ".gitlab-ci.yml"].includes(p)),
    ) &&
    !/(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)|(?:package-lock|pnpm-lock|yarn\.lock)/i.test(
      name,
    ) &&
    (TEXT.test(name) || /^(?:Dockerfile|Makefile|LICENSE|\.gitignore)$/i.test(name))
  );
}
export interface SourceFile {
  path: string;
  content: string;
  hash: string;
  totalLines: number;
  url?: string;
}
export function sourceWindow(file: SourceFile, startLine = 1, endLine = startLine + 119) {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    startLine > file.totalLines
  ) {
    throw new AppError(ErrorCode.BadRequest, "行号超出文件范围");
  }
  const lines = file.content.split(/\r?\n/);
  const stop = Math.min(endLine, startLine + 159, lines.length);
  const selected: string[] = [];
  let chars = 0;
  let line = startLine;
  let partialLine = false;
  for (; line <= stop; line++) {
    const value = `${line}: ${lines[line - 1]!}`;
    if (chars + value.length > 10000) {
      if (!selected.length) {
        selected.push(value.slice(0, 10000));
        partialLine = true;
        line++;
      }
      break;
    }
    selected.push(value);
    chars += value.length + 1;
  }
  const last = line - 1;
  return {
    path: file.path,
    hash: file.hash,
    totalLines: file.totalLines,
    startLine,
    endLine: last,
    content: selected.join("\n"),
    partialLine,
    nextLine: last < file.totalLines ? last + 1 : null,
    truncated: partialLine || last < Math.min(endLine, file.totalLines),
    url: file.url ? `${file.url}#L${startLine}-L${last}` : undefined,
  };
}
export class RepositorySource {
  constructor(
    private readonly projects: {
      list: () => Awaited<ReturnType<ProjectService["list"]>> | ReturnType<ProjectService["list"]>;
    },
    private readonly fetchSource: typeof fetchPublicSource = fetchPublicSource,
  ) {}
  private async json(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchSource(url, {
      signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (response.status !== 200)
      throw new AppError(
        ErrorCode.IntegrationFailed,
        `GitHub 读取失败（HTTP ${response.status}）。请使用可访问的公开仓库，或导入本地项目后阅读。`,
      );
    return JSON.parse(response.text);
  }
  async open(target: string, signal?: AbortSignal): Promise<ReadingSource> {
    signal?.throwIfAborted();
    if (/^https?:/i.test(target)) {
      const url = new URL(target);
      const match = /^\/([\w.-]+)\/([\w.-]+)\/?$/.exec(url.pathname);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !match
      ) {
        throw new AppError(
          ErrorCode.BadRequest,
          "远程导读请使用 https://github.com/owner/repo 仓库首页链接",
        );
      }
      const owner = match[1]!;
      const repo = match[2]!.replace(/\.git$/, "");
      const base = `https://api.github.com/repos/${owner}/${repo}`;
      const meta = z.object({ default_branch: z.string() }).parse(await this.json(base, signal));
      const { sha } = z
        .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
        .parse(
          await this.json(`${base}/commits/${encodeURIComponent(meta.default_branch)}`, signal),
        );
      const tree = z
        .object({
          truncated: z.boolean(),
          tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string() })),
        })
        .parse(await this.json(`${base}/git/trees/${sha}?recursive=1`, signal));
      const files = tree.tree
        .filter((entry) => entry.type === "blob" && entry.mode !== "120000" && readable(entry.path))
        .map((entry) => readingPath(entry.path))
        .sort();
      return {
        kind: "github",
        owner,
        repo,
        commit: sha,
        name: `${owner}/${repo}`,
        files: files.slice(0, MAX_FILES),
        truncated: tree.truncated || files.length > MAX_FILES,
      };
    }
    const all = await this.projects.list();
    const matches = all.filter(
      (p) =>
        p.id === target ||
        p.name.toLowerCase() === target.toLowerCase() ||
        p.path.replaceAll("\\", "/").toLowerCase() ===
          target.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase(),
    );
    if (matches.length !== 1)
      throw new AppError(
        ErrorCode.BadRequest,
        matches.length
          ? "项目名称重复，请使用项目 ID"
          : "未找到已登记项目，请先在项目管理中导入本地仓库",
      );
    const project = matches[0]!;
    return {
      kind: "local",
      projectId: project.id,
      root: await realpath(project.path),
      name: project.name,
    };
  }
  private async localRoot(
    source: Extract<
      ReadingSource,
      {
        kind: "local";
      }
    >,
  ): Promise<string> {
    const project = (await this.projects.list()).find((p) => p.id === source.projectId);
    if (!project) throw new AppError(ErrorCode.NotFound, "导读关联的项目已移除，请重新导入项目");
    return project.path;
  }
  async files(
    source: ReadingSource,
    signal?: AbortSignal,
  ): Promise<{
    files: string[];
    truncated: boolean;
  }> {
    if (source.kind === "github") return { files: source.files, truncated: source.truncated };
    const root = await realpath(await this.localRoot(source));
    if (root !== source.root)
      throw new AppError(ErrorCode.Conflict, "项目根目录已变化，请重新创建导读");
    const queue = [{ path: root, depth: 0 }];
    const files: string[] = [];
    let visited = 0;
    let truncated = false;
    while (queue.length && files.length < MAX_FILES && visited < 15000) {
      signal?.throwIfAborted();
      const dir = queue.shift()!;
      const entries = await readdir(dir.path, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++visited > 15000 || files.length >= MAX_FILES) {
          truncated = true;
          break;
        }
        if (
          entry.isSymbolicLink() ||
          OMIT.has(entry.name) ||
          (entry.name.startsWith(".") &&
            ![".github", ".gitignore", ".gitlab-ci.yml"].includes(entry.name))
        )
          continue;
        const full = join(dir.path, entry.name);
        if (entry.isDirectory()) {
          if (dir.depth >= 12) truncated = true;
          else queue.push({ path: full, depth: dir.depth + 1 });
        } else if (entry.isFile()) {
          const rel = relative(root, full).replaceAll("\\", "/");
          if (readable(rel)) files.push(rel);
        }
      }
    }
    return { files: files.sort(), truncated: truncated || queue.length > 0 };
  }
  async read(source: ReadingSource, input: string, signal?: AbortSignal): Promise<SourceFile> {
    signal?.throwIfAborted();
    const path = readingPath(input);
    if (!readable(path))
      throw new AppError(
        ErrorCode.BadRequest,
        "导读仅支持源码和项目说明，不读取凭据、依赖或构建产物",
      );
    let content: string;
    let url: string | undefined;
    if (source.kind === "local") {
      const root = await realpath(await this.localRoot(source));
      if (root !== source.root)
        throw new AppError(ErrorCode.Conflict, "项目根目录已变化，请重新创建导读");
      const actual = await realpath(join(root, path));
      const rel = relative(root, actual).replaceAll("\\", "/");
      if (isAbsolute(rel) || rel.startsWith("../") || !readable(rel))
        throw new AppError(ErrorCode.BadRequest, "文件实际位置不在可阅读范围内");
      content = (await fsRead(root, path)).content;
    } else {
      if (!source.files.includes(path))
        throw new AppError(ErrorCode.NotFound, "文件不在该版本的可阅读文件目录中");
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const response = await this.fetchSource(
        `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${encoded}`,
        { signal, maxBytes: MAX_BYTES },
      );
      if (response.status !== 200)
        throw new AppError(ErrorCode.IntegrationFailed, `源码读取失败（HTTP ${response.status}）`);
      content = response.text;
      url = `https://github.com/${source.owner}/${source.repo}/blob/${source.commit}/${encoded}`;
    }
    signal?.throwIfAborted();
    if (Buffer.byteLength(content) > MAX_BYTES || content.includes("\0"))
      throw new AppError(ErrorCode.BadRequest, "不支持超过 512 KB 的文本或二进制文件");
    return {
      path,
      content,
      hash: createHash("sha256").update(content).digest("hex"),
      totalLines: content.split(/\r?\n/).length,
      url,
    };
  }
  async search(
    source: ReadingSource,
    query: string,
    prefix = "",
    offset = 0,
    signal?: AbortSignal,
  ) {
    const listing = await this.files(source, signal);
    const files = listing.files.filter((p) => p.startsWith(prefix));
    const batch = files.slice(offset, offset + (source.kind === "github" ? 12 : 60));
    const hits: Array<{
      path: string;
      line: number;
      text: string;
    }> = [];
    const skipped: string[] = [];
    let limited = false;
    for (const path of batch) {
      signal?.throwIfAborted();
      try {
        const file = await this.read(source, path, signal);
        file.content.split(/\r?\n/).forEach((text, i) => {
          if (text.toLowerCase().includes(query.toLowerCase())) {
            if (hits.length < 30) hits.push({ path, line: i + 1, text: text.slice(0, 240) });
            else limited = true;
          }
        });
      } catch (error) {
        signal?.throwIfAborted();
        // 远程限流或网络故障不继续发请求；本地不可读文件显式列出。
        if (source.kind === "github") throw error;
        skipped.push(path);
      }
    }
    const nextOffset = offset + batch.length < files.length ? offset + batch.length : null;
    return {
      hits,
      searchedFiles: batch.length,
      nextOffset,
      skipped,
      truncated: listing.truncated || limited || nextOffset !== null || skipped.length > 0,
    };
  }
}
