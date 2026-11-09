import { defineConfig } from "@playwright/test";

const port = 1442;

export default defineConfig({
  testDir: "./e2e-cloud",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.E2E_BROWSER_CHANNEL ?? "msedge",
    viewport: { width: 390, height: 844 },
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      process.env.CLOUD_E2E_BUILT === "1"
        ? "pnpm --filter @agentdesk/cloud-gateway exec tsx scripts/preview.ts"
        : `pnpm exec vite --config vite.cloud.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/cloud.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
