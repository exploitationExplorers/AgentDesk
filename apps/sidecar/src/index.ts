import { loadConfig, loadEnvFiles } from "./config";
import { startSidecar } from "./runtime";

process.on("unhandledRejection", (reason) => {
  console.error("[sidecar] unhandled rejection", reason);
});

async function main() {
  loadEnvFiles();
  const config = loadConfig();
  const runtime = await startSidecar(config);
  // 保持 Tauri 用于确认 sidecar 就绪的输出协议。
  console.info(`AGENTDESK_READY port=${runtime.port}`);
  console.info(
    `[sidecar] data dir: ${config.dataDir} (secrets: ${runtime.container.secrets.backend})`,
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.close();
      process.exit(0);
    } catch (error) {
      console.error("[sidecar] failed to stop", error);
      process.exit(1);
    }
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
