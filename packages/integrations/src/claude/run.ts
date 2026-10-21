import { spawn } from "node:child_process";
import { listClaudeSessions } from "../claude-sessions";
import { run } from "../exec";

export interface ClaudePrintOptions {
  cwd: string;
  prompt: string;
  /** 可执行文件名或路径，默认 claude */
  claudeCommand?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  /** Claude Code 权限模式，默认 acceptEdits（自动接受文件编辑） */
  permissionMode?: "acceptEdits" | "auto" | "dontAsk" | "plan" | "manual" | "bypassPermissions";
}

export interface ClaudePrintResult {
  text: string;
  exitCode: number;
  raw: string;
  sessionId?: string;
  durationMs: number;
}

function extractTextFromJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  // stream-json：优先最后一条带 result 的行
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    try {
      const data = JSON.parse(line) as {
        type?: string;
        result?: unknown;
        subtype?: string;
      };
      if (typeof data.result === "string") return data.result;
      if (data.type === "result" && data.result != null) {
        return typeof data.result === "string" ? data.result : JSON.stringify(data.result);
      }
    } catch {
      /* next */
    }
  }
  // 兼容单行 json 整包
  const candidates = [trimmed];
  const lastBrace = trimmed.lastIndexOf("\n{");
  if (lastBrace >= 0) candidates.push(trimmed.slice(lastBrace + 1));
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace > 0) candidates.push(trimmed.slice(firstBrace));
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as { result?: unknown };
      if (typeof data.result === "string") return data.result;
      if (data.result != null) return JSON.stringify(data.result);
    } catch {
      /* try next */
    }
  }
  return trimmed;
}

type StreamMsg = {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  result?: unknown;
};

/** 把 stream-json 行转成可读进度，便于工作流日志。 */
export function formatStreamJsonLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let data: StreamMsg;
  try {
    data = JSON.parse(trimmed) as StreamMsg;
  } catch {
    return null;
  }

  if (data.type === "system" && data.subtype === "init") {
    return `[Claude] 已启动${data.session_id ? `（session ${data.session_id.slice(0, 8)}…）` : ""}，等待模型改代码…`;
  }

  if (data.type === "assistant" && Array.isArray(data.message?.content)) {
    const parts: string[] = [];
    for (const block of data.message!.content!) {
      if (block.type === "tool_use") {
        const name = block.name ?? "tool";
        const input = block.input ?? {};
        const path =
          (typeof input.file_path === "string" && input.file_path) ||
          (typeof input.path === "string" && input.path) ||
          (typeof input.filePath === "string" && input.filePath) ||
          "";
        const cmd = typeof input.command === "string" ? String(input.command).slice(0, 120) : "";
        if (path) parts.push(`[Claude] ${name} → ${path}`);
        else if (cmd) parts.push(`[Claude] ${name}：${cmd}`);
        else parts.push(`[Claude] 调用工具 ${name}`);
      } else if (block.type === "text" && block.text?.trim()) {
        const t = block.text.trim().replace(/\s+/g, " ");
        parts.push(`[Claude] ${t.length > 200 ? `${t.slice(0, 200)}…` : t}`);
      }
    }
    return parts.length ? parts.join("\n") : null;
  }

  if (data.type === "user" && Array.isArray(data.message?.content)) {
    // tool_result 噪声大，只提示完成
    const hasTool = data.message!.content!.some((c) => c.type === "tool_result");
    if (hasTool) return `[Claude] 工具执行完毕，继续…`;
  }

  if (data.type === "result") {
    return `[Claude] 本轮结束`;
  }

  return null;
}

/** 无头运行 Claude Code：`stream-json` 实时进度 + git 轮询。 */
export async function runClaudePrint(options: ClaudePrintOptions): Promise<ClaudePrintResult> {
  const command = options.claudeCommand?.trim() || "claude";
  const permissionMode = options.permissionMode ?? "acceptEdits";
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const started = Date.now();

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];

  options.onOutput?.(`[claude.run] 启动 Claude Code（stream-json）…\n`);

  const result = await new Promise<ClaudePrintResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      signal: options.signal,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let lineBuf = "";
    let settled = false;
    let lastProgressAt = Date.now();
    const seenFiles = new Set<string>();

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearInterval(gitPoll);
      const raw = stdout.trim() || stderr.trim();
      resolve({
        text: extractTextFromJson(stdout) || stderr.trim(),
        exitCode,
        raw,
        durationMs: Date.now() - started,
      });
    };

    const emitProgress = (msg: string) => {
      lastProgressAt = Date.now();
      options.onOutput?.(`${msg}\n`);
    };

    const consumeLines = (chunk: string, fromStderr: boolean) => {
      if (fromStderr) {
        // stderr 多为噪声，只透传非空短行
        const t = chunk.trim();
        if (t && t.length < 300 && !t.startsWith("{")) emitProgress(`[Claude/stderr] ${t}`);
        return;
      }
      lineBuf += chunk;
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() ?? "";
      for (const line of parts) {
        const pretty = formatStreamJsonLine(line);
        if (pretty) emitProgress(pretty);
      }
    };

    const timer = setTimeout(() => {
      emitProgress(`[claude.run] 超时 ${Math.round(timeoutMs / 1000)}s，正在终止…`);
      child.kill();
      finish(124);
    }, timeoutMs);

    // 长时间无事件时心跳，避免 UI 像卡住
    const heartbeat = setInterval(() => {
      if (settled) return;
      const idleSec = Math.round((Date.now() - lastProgressAt) / 1000);
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (idleSec >= 20) {
        emitProgress(`[claude.run] 仍在运行… 已 ${elapsed}s（最近 ${idleSec}s 无新事件）`);
      }
    }, 15_000);

    // 轮询 git：一旦有文件变化立刻打日志
    const gitPoll = setInterval(() => {
      if (settled) return;
      void gitChangedFiles(options.cwd, options.signal)
        .then((files) => {
          const fresh = files.filter((f) => !seenFiles.has(f));
          if (!fresh.length) return;
          for (const f of fresh) seenFiles.add(f);
          emitProgress(`[git] 已改动：${fresh.slice(0, 12).join(", ")}`);
        })
        .catch(() => {
          /* ignore */
        });
    }, 8_000);

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      consumeLines(s, false);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      consumeLines(s, true);
    });
    child.on("error", (err) => {
      emitProgress(`[claude.run] 启动失败：${err.message}`);
      finish(1);
    });
    child.on("close", (code) => {
      if (lineBuf.trim()) {
        const pretty = formatStreamJsonLine(lineBuf);
        if (pretty) emitProgress(pretty);
        else stdout += ""; // already in stdout
      }
      finish(code ?? 1);
    });

    // 大段 prompt 走 stdin，避免 Windows 命令行长度限制
    child.stdin?.write(options.prompt, "utf8");
    child.stdin?.end();
  });

  let sessionId: string | undefined;
  try {
    const sessions = await listClaudeSessions(options.cwd, 3);
    sessionId = sessions[0]?.id;
  } catch {
    /* 可选 */
  }

  return { ...result, sessionId };
}

/** 列出工作区未提交改动的路径（porcelain）。 */
export async function gitChangedFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const status = await run("git", ["status", "--porcelain"], { cwd, signal, timeoutMs: 30_000 });
  if (status.code !== 0) return [];
  return status.stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => l.replace(/^[ MADRCU?!]{1,2}\s+/, "").replace(/^.* -> /, ""));
}
