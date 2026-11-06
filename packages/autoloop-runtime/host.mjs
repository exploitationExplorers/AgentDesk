import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createLockServer } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const COMMIT = "22312e16419fc9f542a58044cfbb76f4aec80623";
const DATA_SCHEMA_VERSION = 1;
let server;
let lock;
let handler;
let runtime;
let stopping = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function stop() {
  if (stopping) return;
  stopping = true;
  handler?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  runtime?.db.close();
  await new Promise((resolve) => (lock ? lock.close(resolve) : resolve()));
  process.exit(0);
}

function atomicRules(file, rules) {
  const temporary = join(dirname(file), `rules-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(rules), { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Autoloop Hub 需要内置 Node 24 或更高版本");
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "runtime-manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.nodeVersion !== process.versions.node ||
      manifest.arch !== process.arch ||
      manifest.platform !== process.platform
    )
      throw new Error("Autoloop Hub 运行时与安装清单不匹配");
    const executable = process.platform === "win32" ? "node.exe" : "node";
    if (
      createHash("sha256").update(readFileSync(process.execPath)).digest("hex") !==
      manifest.files[executable]
    )
      throw new Error("Autoloop Hub 运行时完整性检查失败");
  }
  const startupFile = process.argv[2];
  if (!startupFile) throw new Error("Autoloop Hub 必须由 AgentDesk 启动");
  const config = JSON.parse(readFileSync(startupFile, "utf8"));
  const dataDir = realpathSync.native(config.dataDir);
  if (realpathSync.native(dirname(startupFile)) !== dataDir)
    throw new Error("Autoloop 启动配置不在私有目录内");
  const lockId = createHash("sha256")
    .update(process.platform === "win32" ? dataDir.toLowerCase() : dataDir)
    .digest("hex")
    .slice(0, 32);
  lock = createLockServer((socket) => socket.destroy());
  const lockPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\AgentDesk.Autoloop.${lockId}`
      : process.platform === "linux"
        ? `\0agentdesk-autoloop-${lockId}`
        : join(dataDir, "hub.lock.sock");
  await new Promise((resolve, reject) => {
    lock.once("error", () => reject(new Error("该数据目录已有 Autoloop Hub，不能重复启动")));
    lock.listen(lockPath, resolve);
  });
  // 在上游初始化数据库或生成密钥之前拦截不兼容升级，避免盲目重放旧状态。
  const dataVersionFile = join(dataDir, "data-version.json");
  const databaseExists = existsSync(join(dataDir, "hub.db"));
  if (databaseExists && !existsSync(join(dataDir, "master.key")))
    throw new Error("Autoloop 主密钥缺失，请从一致备份恢复数据与密钥");
  if (existsSync(dataVersionFile)) {
    const dataVersion = JSON.parse(readFileSync(dataVersionFile, "utf8"));
    if (dataVersion.schemaVersion !== DATA_SCHEMA_VERSION || dataVersion.upstreamCommit !== COMMIT)
      throw new Error("Autoloop 数据格式与此版本不兼容，请使用原版本或经验证的迁移工具");
  } else if (databaseExists) {
    throw new Error("Autoloop 数据格式未经验证，请先备份并使用明确的迁移流程");
  }
  process.env.AGENT_AUTOLOOP_HOME = dataDir;
  const rulesFile = join(dataDir, "rules.json");
  process.env.AGENT_AUTOLOOP_RULES = rulesFile;
  const { parseRules } = await import("./vendor/protocol/rules.ts");
  parseRules(
    JSON.stringify(config.rules),
    Date.now(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  atomicRules(rulesFile, config.rules);
  runtime = await import("./vendor/host/runtime.ts");
  if (!existsSync(dataVersionFile))
    atomicRules(dataVersionFile, { schemaVersion: DATA_SCHEMA_VERSION, upstreamCommit: COMMIT });
  const { digest } = await import("./vendor/kernel/credentials.ts");
  for (const [kind, token] of Object.entries(config.credentials)) {
    if (
      !["owner", "worker", "source", "channel"].includes(kind) ||
      typeof token !== "string" ||
      token.length < 32
    )
      throw new Error("Autoloop 启动凭据无效");
    const name =
      kind === "worker" ? config.workerName : kind === "source" ? config.sourceName : "agentdesk";
    if (runtime.whose(kind, token) !== name) runtime.keepKeyHash(kind, name, digest(token));
  }
  unlinkSync(startupFile);
  const { makeHandler } = await import("./vendor/host/server.ts");
  handler = makeHandler(COMMIT);
  server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    try {
      if (req.headers.origin) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (Number(req.headers["content-length"] ?? 0) > 1024 * 1024) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "请求最多 1024 KB" }));
        return;
      }
      // 只开放本机控制协议，不加载 webhook 插件或公开卡片页面。
      const path = req.url ?? "/";
      if (path.startsWith("/v1/in/") || path.startsWith("/c/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "没有这个地址" }));
        return;
      }
      const request = new Request(`http://127.0.0.1${path}`, {
        method: req.method,
        headers: req.headers,
        signal: controller.signal,
        ...(req.method === "GET" || req.method === "HEAD"
          ? {}
          : { body: Readable.toWeb(req), duplex: "half" }),
      });
      const response = await handler.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        for await (const chunk of response.body) {
          if (res.destroyed) break;
          if (!res.write(chunk))
            await new Promise((resolve) => {
              const finish = () => {
                res.off("drain", finish);
                res.off("close", finish);
                resolve();
              };
              res.once("drain", finish);
              res.once("close", finish);
            });
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Autoloop Hub 请求暂时无法处理" }));
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.type === "stop") {
      void stop();
      return;
    }
    if (message?.type === "cancel_session" && typeof message.id === "string") {
      try {
        runtime.execute("cancelSession", [message.session]);
        send({ type: "session_cancelled", id: message.id });
      } catch {
        send({
          type: "session_cancel_rejected",
          id: message.id,
          error: "事项停止失败，请检查会话标识并重试",
        });
      }
      return;
    }
    if (message?.type !== "rules" || typeof message.id !== "string") return;
    try {
      runtime.parseRules(JSON.stringify(message.rules));
      atomicRules(rulesFile, message.rules);
      const result = runtime.reloadRules(rulesFile, true);
      if (result.problem) throw new Error(result.problem);
      runtime.tick();
      send({ type: "rules_applied", id: message.id });
    } catch {
      send({
        type: "rules_rejected",
        id: message.id,
        error: "自动化规则无效，已保留上一份有效配置",
      });
    }
  });
  lines.once("close", () => void stop());
  process.once("SIGTERM", () => void stop());
  send({ type: "ready", port: server.address().port });
}

try {
  await main();
} catch (error) {
  send({
    type: "error",
    error:
      error instanceof Error &&
      /已有 Autoloop Hub|运行时|Node 24|数据格式|主密钥/.test(error.message)
        ? error.message
        : "Autoloop Hub 初始化失败，请检查规则与私有数据目录",
  });
  handler?.close();
  runtime?.db.close();
  lock?.close();
  process.exit(1);
}
