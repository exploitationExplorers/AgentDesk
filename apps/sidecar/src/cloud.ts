import { serve } from "@hono/node-server";
import { loadCloudConfig } from "./cloud-config";
import { createCloudApp } from "./cloud-app";
import { createContainer } from "./container";
import { PostgresUnitOfWork } from "./db/postgres";
import { PostgresTaskPersistence } from "./services/storage/postgres-task-persistence";
import { PostgresMessages } from "./services/storage/postgres-messages";
import { PostgresRetentionStore } from "./services/storage/postgres-retention-store";

async function main() {
  const config = loadCloudConfig();
  const db = config.databaseUrl
    ? await PostgresUnitOfWork.connect(config.databaseUrl, config.databaseSchema)
    : undefined;
  let container;
  try {
    const persistence = db ? new PostgresTaskPersistence(db) : undefined;
    await persistence?.initialize();
    container = await createContainer(config, {
      persistence,
      messages: db ? new PostgresMessages(db) : undefined,
      retention: db ? new PostgresRetentionStore(db) : undefined,
      closeBusiness: db ? () => db.close() : undefined,
      cloud: {
        hostId: config.hostId,
        workspaceRoot: config.workspaceRoot,
        taskTimeoutMs: config.taskTimeoutMs,
      },
    });
  } catch (error) {
    await db?.close();
    throw error;
  }
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
  console.error(
    "[cloud-runner] failed to start",
    error instanceof Error ? error.name : "StartupError",
  );
  process.exit(1);
});
