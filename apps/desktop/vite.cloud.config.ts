import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: "public-cloud",
  // 云端入口不继承本地 sidecar 地址、token 或构建机器上的 VITE 配置。
  envPrefix: "AGENTDESK_PUBLIC_CLOUD_",
  server: { host: "127.0.0.1", port: 1440, strictPort: true },
  build: {
    target: "es2022",
    outDir: "dist-cloud",
    sourcemap: false,
    rollupOptions: { input: resolve(root, "cloud.html") },
  },
});
