import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadEnvFiles } from "../../sidecar/src/config";
import { startSidecar, type SidecarRuntime } from "../../sidecar/src/runtime";
import { claimState, publishState, removeOwnedState } from "./state.js";
import { randomBytes } from "node:crypto";
import { readConnector } from "./connect/credentials.js";
import { startConnector } from "./connect/channel.js";
import { createCloudApp } from "../../sidecar/src/cloud-app";

interface RuntimeOptions {
  home: string;
  instanceId: string;
  token: string;
  port: number;
  mode: "foreground" | "background";
}

export async function runCliRuntime(options: RuntimeOptions): Promise<void> {
  const { home, instanceId, token, port, mode } = options;
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    .version as string;
  const state = {
    schemaVersion: 1,
    instanceId,
    token,
    port: 0,
    pid: process.pid,
    mode,
    version,
    startedAt: new Date().toISOString(),
  };
  // 排他创建发生在数据库打开前，避免同时启动两个服务操作同一数据目录。
  claimState(home, state);
  let runtime: SidecarRuntime | undefined;
  let connector: ReturnType<typeof startConnector> | undefined;
  try {
    loadEnvFiles([join(home, ".env"), join(home, "data", ".env")]);
    const config = loadConfig({
      ...process.env,
      AGENTDESK_DATA_DIR: join(home, "data"),
      AGENTDESK_TOKEN: token,
      AGENTDESK_PORT: String(port),
      AGENTDESK_VERSION: version,
      AGENTDESK_SKILLS_DIR:
        process.env.AGENTDESK_SKILLS_DIR ?? fileURLToPath(new URL("./skills", import.meta.url)),
    });
    let resolveStopped: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    let stopping: Promise<void> | undefined;
    const credentials = readConnector(home);
    const stop = () =>
      (stopping ??= (async () => {
        try {
          connector?.stop();
          await runtime?.close();
        } finally {
          removeOwnedState(home, instanceId);
          resolveStopped();
        }
      })());
    runtime = await startSidecar(config, {
      office: credentials
        ? {
            hostId: credentials.hostId,
            taskTimeoutMs: 3_600_000,
            projects: Object.fromEntries(
              credentials.identity.projects
                .filter((p) => credentials.projects.includes(p.id))
                .map((p) => [p.id, p.path]),
            ),
          }
        : undefined,
      webRoot: fileURLToPath(new URL("./web", import.meta.url)),
      configureApp(app, container) {
        app.get("/api/cli/connect/status", (c) =>
          c.json(connector?.status() ?? { state: "stopped" }),
        );
        app.post("/api/cli/connect/stop", (c) => {
          connector?.stop();
          if (credentials)
            container.dbHandle.raw
              .prepare("UPDATE remote_project_grants SET revoked_at=? WHERE host_id=?")
              .run(new Date().toISOString(), credentials.hostId);
          return c.json({ stopped: true });
        });
        app.get("/api/cli/instance", (c) =>
          c.json({
            instanceId,
            pid: process.pid,
            version,
            mode,
            dataDir: config.dataDir,
          }),
        );
        app.post("/api/cli/shutdown", (c) => {
          setTimeout(() => {
            void stop().then(
              () => process.exit(0),
              (error) => {
                console.error("[cli] failed to stop", error);
                process.exit(1);
              },
            );
          }, 25);
          return c.json({ stopping: true });
        });
      },
    });
    if (credentials?.enabled) {
      const remoteToken = randomBytes(32).toString("hex");
      const remoteApp = createCloudApp(runtime.container, {
        ...config,
        kind: "office",
        hostId: credentials.hostId,
        name: credentials.identity.name,
        workspaceRoot: config.dataDir,
        remoteToken,
        taskTimeoutMs: 3_600_000,
        ownerUserId: credentials.userId,
        allowedProviderHosts: (
          process.env.PROVIDER_ALLOWED_HOSTS ?? "api.openai.com,api.anthropic.com,api.deepseek.com"
        )
          .split(",")
          .map((v) => v.trim().toLowerCase())
          .filter(Boolean),
      });
      connector = startConnector(
        credentials,
        (request) => remoteApp.fetch(request),
        (request) => {
          const authenticated = new Request(request);
          authenticated.headers.set("x-agentdesk-remote-token", remoteToken);
          return authenticated;
        },
      );
    }
    await publishState(home, { ...state, port: runtime.port });
    console.info(`[cli] ready http://127.0.0.1:${runtime.port} (${mode}, PID ${process.pid})`);
    const onSignal = () => {
      void stop().then(
        () => process.exit(0),
        (error) => {
          console.error("[cli] failed to stop", error);
          process.exit(1);
        },
      );
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    if (process.env.AGENTDESK_PARENT_STDIN === "1") {
      process.stdin.resume();
      process.stdin.once("end", onSignal);
      if (process.stdin.readableEnded) onSignal();
    }
    await stopped;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.stdin.removeListener("end", onSignal);
  } catch (error) {
    await runtime?.close();
    removeOwnedState(home, instanceId);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    AGENTDESK_CLI_HOME: home,
    AGENTDESK_CLI_INSTANCE: instanceId,
    AGENTDESK_CLI_TOKEN: token,
  } = process.env;
  if (!home || !instanceId || !token) {
    console.error("请通过 agentdesk start 启动此运行服务。");
    process.exitCode = 1;
  } else {
    await runCliRuntime({
      home,
      instanceId,
      token,
      port: Number(process.env.AGENTDESK_CLI_PORT ?? 17891),
      mode: process.env.AGENTDESK_CLI_MODE === "foreground" ? "foreground" : "background",
    }).catch((error: unknown) => {
      console.error("[cli] failed to start:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
  }
}
