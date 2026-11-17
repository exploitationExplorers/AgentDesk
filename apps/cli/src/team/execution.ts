import { open, readdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { teamExecutionText, type TeamExecutionInput } from "@agentdesk/shared";

export type ExecutionSink = (entry: Omit<TeamExecutionInput, "id">) => void;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const contents = (value: unknown) => (Array.isArray(value) ? value.map(object) : []);
const textContent = (value: unknown): string =>
  typeof value === "string"
    ? value
    : contents(value)
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join("\n");

/** 只投影可见回复和工具活动，不读取 reasoning / thinking 或用户输入。 */
export function transcriptEntries(executor: "codex" | "claude", raw: unknown) {
  const row = object(raw),
    entries: Array<Omit<TeamExecutionInput, "id">> = [];
  const add = (kind: TeamExecutionInput["kind"], text: unknown) => {
    if (typeof text === "string" && text.trim()) entries.push({ kind, text });
  };
  if (executor === "codex" && row.type === "response_item") {
    const p = object(row.payload);
    if (p.type === "message" && p.role === "assistant" && p.channel !== "analysis")
      add(
        "message",
        contents(p.content)
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("\n"),
      );
    if (p.type === "function_call") {
      let args: Record<string, unknown> = {};
      try {
        args = object(JSON.parse(String(p.arguments)));
      } catch {
        /* 非 JSON 参数只展示工具名。 */
      }
      add(
        "command",
        `${String(p.name)}${typeof args.cmd === "string" ? "\n" + args.cmd : typeof args.command === "string" ? "\n" + args.command : ""}`,
      );
    }
    if (p.type === "custom_tool_call") add("command", String(p.name));
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output")
      add("output", typeof p.output === "string" ? p.output : textContent(p.output));
  }
  if (executor === "claude") {
    const message = object(row.message);
    for (const content of contents(message.content)) {
      if (row.type === "assistant" && content.type === "text") add("message", content.text);
      if (row.type === "assistant" && content.type === "tool_use") {
        const input = object(content.input);
        add(
          "command",
          `${String(content.name)}${typeof input.command === "string" ? "\n" + input.command : typeof input.file_path === "string" ? "\n" + input.file_path : ""}`,
        );
      }
      if (row.type === "user" && content.type === "tool_result")
        add("output", textContent(content.content));
    }
  }
  return entries;
}

function sameDirectory(a: string, b: string) {
  return process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}

/** 只跟随启动后创建、且元数据 cwd 与本任务 worktree 完全一致的日志。 */
export function watchTaskTranscript(options: {
  executor: "codex" | "claude";
  cwd: string;
  emit: ExecutionSink;
  root?: string;
  startedAt?: number;
}) {
  const startedAt = options.startedAt ?? Date.now();
  const root =
    options.root ??
    (options.executor === "codex"
      ? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")
      : join(
          process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
          "projects",
          options.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
        ));
  let filename = "",
    offset = 0,
    stopped = false,
    busy: Promise<void> | undefined;
  let lastDiscovery = 0,
    reported = false;
  const inspect = async () => {
    if (!filename) {
      if (Date.now() - lastDiscovery < 1500) return;
      lastDiscovery = Date.now();
      const directories =
        options.executor === "codex" && !options.root
          ? [-1, 0, 1].map((day) => {
              const date = new Date(Date.now() + day * 86400000)
                .toISOString()
                .slice(0, 10)
                .split("-");
              return join(root, ...date);
            })
          : [root];
      for (const directory of directories) {
        let files: string[];
        try {
          files = await readdir(directory);
        } catch {
          continue;
        }
        for (const file of files.slice(-500)) {
          if (!file.endsWith(".jsonl")) continue;
          const candidate = join(directory, file);
          const stat = await lstat(candidate).catch(() => undefined);
          if (!stat?.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt - 1000) continue;
          const handle = await open(candidate, "r");
          try {
            const head = Buffer.alloc(8192);
            const { bytesRead } = await handle.read(head, 0, head.length, 0);
            const line = head.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
            let meta: Record<string, unknown>;
            try {
              meta = object(JSON.parse(line));
            } catch {
              continue;
            }
            const cwd =
              options.executor === "codex" && meta.type === "session_meta"
                ? object(meta.payload).cwd
                : meta.cwd;
            if (typeof cwd === "string" && sameDirectory(cwd, options.cwd)) {
              filename = candidate;
              break;
            }
          } finally {
            await handle.close();
          }
        }
        if (filename) break;
      }
    }
    if (!filename) return;
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < offset)
      throw Error("任务日志已替换");
    const handle = await open(filename, "r");
    try {
      const chunk = Buffer.alloc(Math.min(256 * 1024, stat.size - offset));
      if (!chunk.length) return;
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      offset += bytesRead;
      // 跨读取的 UTF-8 字符通过 Buffer 尾部保留，避免损坏中文输出。
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        if (line.length > 256 * 1024) continue;
        try {
          for (const entry of transcriptEntries(options.executor, JSON.parse(line)))
            options.emit(entry);
        } catch {
          /* 不把原始坏日志或异常正文上传。 */
        }
      }
      if (pending.length > 512 * 1024) throw Error("任务日志行超过共享上限");
    } finally {
      await handle.close();
    }
  };
  let pending = Buffer.alloc(0);
  const poll = () => {
    if (busy || stopped) return busy;
    busy = inspect()
      .catch(() => {
        if (!reported)
          options.emit({
            kind: "notice",
            text: "任务详细日志暂不可读取；本机终端继续显示完整过程。",
          });
        reported = true;
      })
      .finally(() => {
        busy = undefined;
      });
    return busy;
  };
  const timer = setInterval(() => void poll(), 750);
  return async () => {
    clearInterval(timer);
    await busy;
    await poll();
    stopped = true;
    if (!filename)
      options.emit({
        kind: "notice",
        text: "未发现本任务的兼容会话日志。阶段、文件变更与检查仍会上报；完整工具输出请查看本机终端。",
      });
  };
}

/** 有界、有序批次；失败重试沿用事件 ID，不重复写入已接收记录。 */
export function executionReporter(
  send: (entries: TeamExecutionInput[]) => Promise<unknown>,
  secrets: string[] = [],
) {
  const pending: TeamExecutionInput[] = [];
  let active: Promise<void> | undefined,
    failure: unknown,
    overflow = false;
  const emit: ExecutionSink = (entry) => {
    const text = teamExecutionText(entry.text, secrets);
    if (!text) return;
    if (pending.length >= 128) {
      overflow = true;
      return;
    }
    pending.push({ ...entry, text, id: randomUUID() });
  };
  const flush = async () => {
    if (active) return active;
    active = (async () => {
      while (pending.length) {
        const batch = pending.slice(0, 12);
        try {
          await send(batch);
          pending.splice(0, batch.length);
          failure = undefined;
        } catch (error) {
          failure = error;
          break;
        }
      }
      if (overflow && pending.length < 128) {
        overflow = false;
        emit({ kind: "notice", text: "输出过快，部分共享记录已省略；本机终端保留完整输出。" });
      }
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
  const timer = setInterval(() => void flush(), 750);
  return {
    emit,
    flush,
    close: async () => {
      clearInterval(timer);
      await flush();
      if (failure) console.error("执行记录未能完整同步，请检查网络；本机输出仍可查看。");
    },
  };
}
