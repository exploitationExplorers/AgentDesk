import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { AppError, ErrorCode, type Artifact, type ArtifactContent } from "@agentdesk/shared";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".yaml",
  ".yml",
  ".xml",
  ".svg",
  ".log",
  ".diff",
  ".patch",
  ".py",
  ".go",
  ".rs",
  ".sql",
]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};
const PRIVATE_NAMES = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".codex",
  ".claude",
  "credentials",
  "dev-master.key",
]);

export function artifactMime(artifact: Pick<Artifact, "filePath" | "mimeType" | "kind">): string {
  if (artifact.kind === "change") return "text/plain";
  const extension = extname(artifact.filePath ?? "").toLowerCase();
  if (
    !artifact.filePath &&
    artifact.mimeType &&
    ["text/plain", "text/markdown", "text/html", "application/json"].includes(artifact.mimeType)
  ) {
    return artifact.mimeType === "application/json" ? "text/plain" : artifact.mimeType;
  }
  if (IMAGE_MIME[extension]) return IMAGE_MIME[extension];
  if (extension === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".md" || !artifact.filePath) return "text/markdown";
  if (TEXT_EXTENSIONS.has(extension)) return "text/plain";
  // 未经识别的文件只可下载，不用声明的 MIME 将二进制解释成 HTML。
  return "application/octet-stream";
}

function strictChild(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function validateArtifactPath(workspace: string | undefined, path: string): string {
  if (!workspace) throw new AppError(ErrorCode.BadRequest, "该成果没有绑定项目目录，无法读取文件");
  const root = resolve(workspace);
  const target = resolve(root, path);
  if (!strictChild(root, target))
    throw new AppError(ErrorCode.BadRequest, "成果文件不在任务项目目录内");
  const parts = relative(root, target)
    .split(sep)
    .map((part) => part.toLowerCase());
  if (
    parts.some(
      (part) =>
        PRIVATE_NAMES.has(part) ||
        part === ".env" ||
        part.startsWith(".env.") ||
        /\.(pem|key|p12|pfx)$/.test(part),
    )
  ) {
    throw new AppError(ErrorCode.BadRequest, "成果路径包含凭据或受保护内容");
  }
  return target;
}

export async function readArtifactFile(
  workspace: string | undefined,
  path: string,
): Promise<Buffer> {
  const target = validateArtifactPath(workspace, path);
  const root = await realpath(resolve(workspace!));
  const resolved = await realpath(target);
  if (!strictChild(root, resolved))
    throw new AppError(ErrorCode.BadRequest, "成果真实路径已离开任务项目目录");
  validateArtifactPath(root, resolved);
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new AppError(ErrorCode.BadRequest, "成果必须是普通文件");
  if (stat.size > MAX_ARTIFACT_BYTES)
    throw new AppError(ErrorCode.BadRequest, "成果超过 10 MB，请从项目目录打开");
  const file = await open(resolved, "r");
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > MAX_ARTIFACT_BYTES)
      throw new AppError(ErrorCode.BadRequest, "成果文件类型或大小发生变化");
    // 多读一个字节以检测读取期间文件增长，避免无界 readFile。
    const buffer = Buffer.alloc(Math.min(current.size + 1, MAX_ARTIFACT_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_ARTIFACT_BYTES)
      throw new AppError(ErrorCode.BadRequest, "成果超过 10 MB，请从项目目录打开");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function artifactContent(
  artifact: Artifact,
  workspace?: string,
): Promise<ArtifactContent> {
  const mimeType = artifactMime(artifact);
  const snapshot = artifact.content !== null;
  const fileBacked = artifact.filePath && artifact.kind !== "change";
  if (fileBacked) validateArtifactPath(workspace, artifact.filePath!);
  let disk: Buffer | undefined;
  if (fileBacked) {
    try {
      disk = await readArtifactFile(workspace, artifact.filePath!);
    } catch (error) {
      // 历史快照即使源文件被删除仍可读，越界路径和权限异常不能被吞掉。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!snapshot) throw new AppError(ErrorCode.NotFound, "成果文件已经不存在");
      } else throw error;
    }
  }
  if (!snapshot && !disk) throw new AppError(ErrorCode.NotFound, "该成果没有可预览的内容");
  const text = snapshot ? artifact.content! : disk!.toString("utf8");
  const binary = !mimeType.startsWith("text/") && !snapshot;
  return {
    artifact,
    content: binary ? disk!.toString("base64") : text,
    encoding: binary ? "base64" : "utf8",
    mimeType,
    editable: !binary && mimeType !== "application/octet-stream" && artifact.kind !== "change",
    source: snapshot ? "snapshot" : "file",
    changedOnDisk:
      snapshot && fileBacked
        ? !disk ||
          createHash("sha256").update(disk).digest("hex") !==
            createHash("sha256").update(text).digest("hex")
        : null,
  };
}

export function artifactDownloadName(artifact: Artifact): string {
  const name = artifact.filePath
    ? `${basename(artifact.filePath)}${artifact.kind === "change" ? ".diff" : ""}`
    : `${artifact.title || "成果"}.${artifact.kind === "change" ? "diff" : artifact.mimeType === "text/html" ? "html" : "md"}`;
  return name.replace(/[\r\n"\\/]/g, "_");
}
