import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadEnvFiles } from "../../sidecar/src/config";
import { startSidecar, type SidecarRuntime } from "../../sidecar/src/runtime";
import { claimState, publishState, removeOwnedState } from "./state.js";

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
    const stop = () =>
      (stopping ??= (async () => {
        try {
          await runtime?.close();
        } finally {
          removeOwnedState(home, instanceId);
          resolveStopped();
        }
      })());
    runtime = await startSidecar(config, {
      webRoot: fileURLToPath(new URL("./web", import.meta.url)),
      configureApp(app) {
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
    await stopped;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
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
      mode: "background",
    }).catch((error: unknown) => {
      console.error("[cli] failed to start:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
  }
}
