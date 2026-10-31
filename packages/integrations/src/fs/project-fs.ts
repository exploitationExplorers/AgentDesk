import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import { contentHash, fileChange } from "./file-change";

const MAX_READ_BYTES = 512_000;

export class ProjectFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFsError";
  }
}

/** 确保候选路径落在项目根下，返回规范化绝对路径 */
export function resolveUnderRoot(projectRoot: string, relOrAbs: string): string {
  const root = resolve(projectRoot);
  const candidate = resolve(root, relOrAbs);
  const rel = relative(root, candidate);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new ProjectFsError(`路径越界：${relOrAbs} 不在项目根 ${root} 内`);
  }
  return candidate;
}

/** 路径中的 junction / symlink 也必须留在项目内，包括尚不存在文件的父目录。 */
async function checkedPath(root: string, path: string): Promise<string> {
  const full = resolveUnderRoot(root, path);
  const actualRoot = await realpath(root);
  let parent = full;
  for (;;) {
    try {
      resolveUnderRoot(actualRoot, await realpath(parent));
      return full;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

const mutations = new Map<string, Promise<unknown>>();
async function mutate<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  mutations.set(key, next);
  try {
    return await next;
  } finally {
    if (mutations.get(key) === next) mutations.delete(key);
  }
}

function checkVersion(content: string | null, expectedHash?: string): void {
  if (expectedHash !== undefined && (content === null ? "" : contentHash(content)) !== expectedHash)
    throw new ProjectFsError("文件在读取后已改变，请重新读取后再修改");
}

export async function fsRead(
  projectRoot: string,
  path: string,
): Promise<{ path: string; content: string; bytes: number; hash: string }> {
  const full = await checkedPath(projectRoot, path);
  const st = await stat(full);
  if (!st.isFile()) throw new ProjectFsError(`不是文件：${path}`);
  if (st.size > MAX_READ_BYTES)
    throw new ProjectFsError(`文件过大（>${MAX_READ_BYTES} 字节）：${path}`);
  const content = await readFile(full, "utf8");
  if (content.includes("\0")) throw new ProjectFsError(`不支持二进制文件：${path}`);
  return {
    path: full,
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    hash: contentHash(content),
  };
}

export async function fsWrite(
  projectRoot: string,
  path: string,
  content: string,
  options: { expectedHash?: string; signal?: AbortSignal } = {},
) {
  const full = await checkedPath(projectRoot, path);
  return mutate(full, async () => {
    options.signal?.throwIfAborted();
    if (Buffer.byteLength(content, "utf8") > MAX_READ_BYTES || content.includes("\0"))
      throw new ProjectFsError("仅支持不超过 512 KB 的文本文件");
    let before: string | null = null;
    try {
      before = (await fsRead(projectRoot, path)).content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    checkVersion(before, options.expectedHash);
    const change = fileChange(full, before, content);
    await mkdir(dirname(full), { recursive: true });
    await checkedPath(projectRoot, path);
    options.signal?.throwIfAborted();
    await writeFile(full, content, "utf8");
    return {
      path: full,
      bytes: Buffer.byteLength(content, "utf8"),
      change,
    };
  });
}

export async function fsPatch(
  projectRoot: string,
  path: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; expectedHash?: string; signal?: AbortSignal } = {},
) {
  if (!oldText) throw new ProjectFsError("oldText 不能为空");
  const full = await checkedPath(projectRoot, path);
  return mutate(full, async () => {
    options.signal?.throwIfAborted();
    const { content } = await fsRead(projectRoot, path);
    checkVersion(content, options.expectedHash);
    const ending = content.includes("\r\n") ? "\r\n" : "\n";
    const normalized = content.replace(/\r\n/g, "\n");
    const parts = normalized.split(oldText.replace(/\r\n/g, "\n"));
    const replacements = parts.length - 1;
    if (replacements === 0) throw new ProjectFsError(`未找到要替换的文本：${path}`);
    if (replacements > 1 && !options.replaceAll)
      throw new ProjectFsError(
        `找到 ${replacements} 处匹配，请增加上下文使其唯一，或显式设置 replaceAll=true`,
      );
    const after = parts.join(newText.replace(/\r\n/g, "\n")).replace(/\n/g, ending);
    if (Buffer.byteLength(after, "utf8") > MAX_READ_BYTES || after.includes("\0"))
      throw new ProjectFsError("修改结果超过 512 KB 或包含二进制内容");
    const change = fileChange(full, content, after);
    await checkedPath(projectRoot, path);
    options.signal?.throwIfAborted();
    await writeFile(full, after, "utf8");
    return { path: full, replacements, change };
  });
}

export async function fsGlob(projectRoot: string, pattern: string, max = 80): Promise<string[]> {
  const root = resolve(projectRoot);
  const needle = pattern.replace(/\\/g, "/").toLowerCase();
  const out: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= max || depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist") continue;
      if (ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (matchGlob(rel.toLowerCase(), needle)) {
        out.push(rel);
      }
    }
  }

  await walk(root, 0);
  return out;
}

export async function fsSearch(
  projectRoot: string,
  query: string,
  glob = "*.{ts,tsx,js,jsx,vue}",
  maxHits = 40,
): Promise<Array<{ path: string; line: number; text: string }>> {
  if (!query.trim()) return [];
  const files = await fsGlob(projectRoot, glob.includes("*") ? glob : `**/*${glob}*`, 200);
  const hits: Array<{ path: string; line: number; text: string }> = [];
  const q = query.toLowerCase();
  for (const rel of files) {
    if (hits.length >= maxHits) break;
    try {
      const { content } = await fsRead(projectRoot, rel);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= maxHits) break;
        const line = lines[i]!;
        if (line.toLowerCase().includes(q)) {
          hits.push({ path: rel, line: i + 1, text: line.trim().slice(0, 200) });
        }
      }
    } catch {
      /* skip binary / unreadable */
    }
  }
  return hits;
}

/** 极简 glob：支持 * 与 ** 片段、以及子串匹配兜底 */
function matchGlob(path: string, pattern: string): boolean {
  if (!pattern || pattern === "*" || pattern === "**") return true;
  if (!/[*?{[]/.test(pattern)) return path.includes(pattern);
  return matchesGlob(path, pattern.includes("/") ? pattern : `**/${pattern}`);
}
