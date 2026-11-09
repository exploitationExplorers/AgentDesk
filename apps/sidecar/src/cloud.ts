import { serve } from "@hono/node-server";
import { loadCloudConfig } from "./cloud-config";
import { createCloudApp } from "./cloud-app";
import { createContainer } from "./container";

async function main() {
  const config = loadCloudConfig();
  const container = await createContainer(config, {
    cloud: {
      hostId: config.hostId,
      workspaceRoot: config.workspaceRoot,
      taskTimeoutMs: config.taskTimeoutMs,
    },
  });
  await container.cloudRunner!.registerConfiguredWorkspaces();
  const app = createCloudApp(container, config);
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  console.info(`[cloud-runner] listening on ${config.host}:${config.port}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    container.beginShutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await container.dispose();
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("[cloud-runner] failed to start", error);
  process.exit(1);
});
