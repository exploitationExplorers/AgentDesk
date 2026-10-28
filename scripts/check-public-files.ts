import { execFileSync, type ExecFileSyncOptionsWithBufferEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args: string[], options: ExecFileSyncOptionsWithBufferEncoding = {}) =>
  execFileSync("git", ["-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });

export interface PublicFileIssue {
  file: string;
  reason: string;
  line?: number;
  object?: string;
}

export function inspectFile(file: string, content: Buffer): PublicFileIssue[] {
  const path = file.replaceAll("\\", "/");
  const name = path.split("/").at(-1) ?? "";
  const example = /^\.env(?:\..+)?\.example$/.test(name);
  const privatePath =
    (!example && /^\.env(?:\.|$)/.test(name)) ||
    /(?:^|\/)(?:wechat-daily-report|skills-private|secrets|credentials|\.data|browser-profiles|decrypted|wechat-reports)(?:\/|$)/.test(
      path,
    ) ||
    /\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$|\.(?:key|pem|p12|pfx)$/.test(name) ||
    /^\.tmp/.test(name);
  if (privatePath) return [{ file, reason: "私有文件不应纳入公开仓库" }];
  if (content.includes(0)) return [];

  const issues: PublicFileIssue[] = [];
  const token =
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/;
  const assignment =
    /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']([^"'\r\n]{24,})["']/i;
  const placeholder = /example|placeholder|dummy|test|fake|your[-_ ]|<[^>]+>|\$\{|process\.env/i;
  content
    .toString("utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const assigned = assignment.exec(line)?.[1];
      if (
        /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(line) ||
        token.test(line) ||
        (assigned && !placeholder.test(assigned) && /^[A-Za-z0-9_+/.=-]+$/.test(assigned))
      ) {
        issues.push({ file, line: index + 1, reason: "疑似硬编码密钥，请改用本地配置或密钥存储" });
      }
    });
  return issues;
}

function scanCurrent(staged: boolean): PublicFileIssue[] {
  const args = staged
    ? ["ls-files", "--cached", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const files = [...new Set(git(args).toString("utf8").split("\0").filter(Boolean))];
  return files.flatMap((file) => {
    let content;
    try {
      content = staged ? git(["show", `:${file}`]) : readFileSync(resolve(root, file));
    } catch (error) {
      if (!staged && error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
    return inspectFile(file, content);
  });
}

function scanHistory(): PublicFileIssue[] {
  const objects = git(["rev-list", "--objects", "--all"])
    .toString("utf8")
    .trim()
    .split("\n")
    .map((line) => ({ oid: line.slice(0, 40), file: line.slice(41) }))
    .filter(({ file }) => file);
  if (!objects.length) return [];
  const batch = git(["cat-file", "--batch"], {
    input: objects.map(({ oid }) => oid).join("\n") + "\n",
  });
  const issues: PublicFileIssue[] = [];
  let offset = 0;
  for (const { oid, file } of objects) {
    const end = batch.indexOf(10, offset);
    const [, type, size] = batch.subarray(offset, end).toString("utf8").split(" ");
    offset = end + 1;
    const content = batch.subarray(offset, offset + Number(size));
    offset += Number(size) + 1;
    if (type === "blob") {
      issues.push(
        ...inspectFile(file, content).map((issue) => ({ ...issue, object: oid.slice(0, 12) })),
      );
    }
  }
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const issues = scanCurrent(process.argv.includes("--staged"));
    if (process.argv.includes("--history")) issues.push(...scanHistory());
    for (const issue of issues) {
      // 只打印定位信息，避免在终端、CI 或日志中再次暴露密钥。
      console.error(
        `${issue.object ? `[history ${issue.object}] ` : ""}${issue.file}${issue.line ? `:${issue.line}` : ""}：${issue.reason}`,
      );
    }
    if (issues.length) {
      console.error(`公开检查未通过，共 ${issues.length} 处；未输出任何密钥原文。`);
      process.exitCode = 1;
    } else {
      console.info("公开检查通过：未发现受限私有文件或已知格式的密钥。此检查不能替代人工审查。");
    }
  } catch {
    console.error("公开检查无法完成，请确认 Git 和待检查文件可读取；未输出文件内容。");
    process.exitCode = 1;
  }
}
