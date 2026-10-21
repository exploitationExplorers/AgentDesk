import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

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
  if (rel.startsWith("..") || rel === ".." || normalize(rel).startsWith(`..${sep}`)) {
    throw new ProjectFsError(`路径越界：${relOrAbs} 不在项目根 ${root} 内`);
  }
  return candidate;
}

export async function fsRead(
  projectRoot: string,
  path: string,
): Promise<{ path: string; content: string; bytes: number }> {
  const full = resolveUnderRoot(projectRoot, path);
  const st = await stat(full);
  if (!st.isFile()) throw new ProjectFsError(`不是文件：${path}`);
  if (st.size > MAX_READ_BYTES)
    throw new ProjectFsError(`文件过大（>${MAX_READ_BYTES} 字节）：${path}`);
  const content = await readFile(full, "utf8");
  return { path: full, content, bytes: Buffer.byteLength(content, "utf8") };
}

export async function fsWrite(
  projectRoot: string,
  path: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const full = resolveUnderRoot(projectRoot, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return { path: full, bytes: Buffer.byteLength(content, "utf8") };
}

export async function fsPatch(
  projectRoot: string,
  path: string,
  oldText: string,
  newText: string,
): Promise<{ path: string; replacements: number }> {
  if (!oldText) throw new ProjectFsError("oldText 不能为空");
  const { content, path: full } = await fsRead(projectRoot, path);
  const parts = content.split(oldText);
  const replacements = parts.length - 1;
  if (replacements === 0) throw new ProjectFsError(`未找到要替换的文本：${path}`);
  await writeFile(full, parts.join(newText), "utf8");
  return { path: full, replacements };
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
  if (!pattern.includes("*")) return path.includes(pattern);
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ":::DBL:::")
    .replace(/\*/g, "[^/]*")
    .replace(/:::DBL:::/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i").test(path) || path.includes(pattern.replace(/\*/g, ""));
  } catch {
    return path.includes(pattern.replace(/\*/g, ""));
  }
}
