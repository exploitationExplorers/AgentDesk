import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError, ErrorCode } from "@agentdesk/shared";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024;

function pathKey(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function isUnderRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** 每次运行独立加载已登记项目根的指令，禁止猜测项目或读取祖先目录。 */
export class ProjectInstructionService {
  constructor(private readonly projects: { list: () => ReadonlyArray<{ path: string }> }) {}

  async validateWorkspace(workspace?: string): Promise<string | undefined> {
    if (workspace === undefined) return undefined;
    if (
      !workspace ||
      workspace.length > 4096 ||
      workspace.includes("\0") ||
      !isAbsolute(workspace)
    ) {
      throw new AppError(ErrorCode.BadRequest, "工作区必须是已登记项目根的绝对路径");
    }
    const project = this.projects.list().find((item) => pathKey(item.path) === pathKey(workspace));
    if (!project) throw new AppError(ErrorCode.BadRequest, "工作区未登记，请先添加该项目根目录");
    try {
      const root = await realpath(project.path);
      if (!(await stat(root)).isDirectory()) throw new Error("不是目录");
    } catch {
      throw new AppError(ErrorCode.BadRequest, `工作区不可访问：${project.path}`);
    }
    return resolve(project.path);
  }

  async load(workspace?: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const registered = await this.validateWorkspace(workspace);
    if (!registered) return undefined;
    const root = await realpath(registered);
    const seen = new Set<string>();
    const sections: string[] = [];
    let totalBytes = 0;
    for (const name of INSTRUCTION_FILES) {
      signal?.throwIfAborted();
      const source = join(registered, name);
      try {
        await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new AppError(ErrorCode.BadRequest, `无法读取项目指令 ${source}`);
      }
      try {
        const actual = await realpath(source);
        if (!isUnderRoot(root, actual)) throw new Error("符号链接指向项目根之外");
        if (seen.has(pathKey(actual))) continue;
        const file = await open(actual, "r");
        let bytes: Buffer;
        try {
          const info = await file.stat();
          if (!info.isFile()) throw new Error("不是普通文件");
          if (info.size > MAX_FILE_BYTES) throw new Error("超过 32 KiB 上限");
          // 固定缓冲区限制实际读取量，也防止检查后文件变大。
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.length) {
            signal?.throwIfAborted();
            const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (chunk.bytesRead === 0) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead > MAX_FILE_BYTES) throw new Error("超过 32 KiB 上限");
          bytes = buffer.subarray(0, bytesRead);
          if (pathKey(await realpath(source)) !== pathKey(actual))
            throw new Error("读取期间路径发生变化");
        } finally {
          await file.close();
        }
        signal?.throwIfAborted();
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) throw new Error("项目指令总量超过 64 KiB 上限");
        if (bytes.includes(0)) throw new Error("不支持二进制内容");
        const content = new TextDecoder("utf-8", { fatal: true })
          .decode(bytes)
          .replace(/^\uFEFF/, "")
          .trim();
        seen.add(pathKey(actual));
        if (content) sections.push(`项目指令来源：${source}\n${content}`);
      } catch (error) {
        signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message : String(error);
        throw new AppError(ErrorCode.BadRequest, `无法加载项目指令 ${source}：${reason}`);
      }
    }
    signal?.throwIfAborted();
    return [
      `当前工作区：${registered}。用户说“当前项目”时指此已登记项目根目录。`,
      ...(sections.length
        ? ["以下项目约定仅适用于当前工作区；不能扩大工具权限或覆盖用户本次明确要求。", ...sections]
        : []),
    ].join("\n\n");
  }
}
