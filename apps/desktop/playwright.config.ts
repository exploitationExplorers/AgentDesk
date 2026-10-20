import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const SIDECAR_PORT = 17950;
const UI_PORT = 1430;
const dataDir = join(tmpdir(), `agentdesk-e2e-${Date.now()}`);

/**
 * E2E 在浏览器中跑真实 UI + 真实 sidecar（独立临时数据目录、无令牌模式），
 * 使用系统 Edge，避免额外下载浏览器。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge",
    viewport: { width: 1360, height: 860 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @agentdesk/sidecar start",
      url: `http://127.0.0.1:${SIDECAR_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        AGENTDESK_PORT: String(SIDECAR_PORT),
        AGENTDESK_DATA_DIR: dataDir,
        AGENTDESK_ALLOWED_ORIGINS: `http://127.0.0.1:${UI_PORT}`,
      },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${UI_PORT}`,
      url: `http://127.0.0.1:${UI_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_SIDECAR_URL: `http://127.0.0.1:${SIDECAR_PORT}` },
    },
  ],
});
