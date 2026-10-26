import { serve } from "@hono/node-server";
import { loadConfig, loadEnvFiles } from "./config";
import { createContainer } from "./container";
import { createApp } from "./http/app";
import { applyProxy, resolveProxy } from "./proxy";

process.on("unhandledRejection", (reason) => {
  console.error("[sidecar] unhandled rejection", reason);
});

async function main() {
  loadEnvFiles();
  const config = loadConfig();
  const container = await createContainer(config);
  const proxy = resolveProxy(container.settings.get().proxy);
  applyProxy(proxy);
  const app = createApp(container);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    // Tauri 通过这一行确认 sidecar 已就绪
    console.info(`AGENTDESK_READY port=${info.port}`);
    console.info(
      `[sidecar] data dir: ${config.dataDir} (secrets: ${container.secrets.backend}, proxy: ${proxy ?? "none"})`,
    );
  });
  container.scheduler.start();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await container.dispose().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Tauri 退出时关闭 stdin，sidecar 随之退出，避免残留进程
  if (process.env.AGENTDESK_PARENT_STDIN === "1") {
    process.stdin.resume();
    process.stdin.on("end", shutdown);
  }
}

main().catch((error) => {
  console.error("[sidecar] failed to start", error);
  process.exit(1);
});
