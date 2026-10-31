import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // npm 内置工作台只能连接当前 CLI，避免构建机环境里的服务地址或令牌进入发行文件。
  define:
    mode === "cli"
      ? {
          "import.meta.env.VITE_AGENTDESK_MODE": JSON.stringify("cli"),
          "import.meta.env.VITE_SIDECAR_URL": JSON.stringify(""),
          "import.meta.env.VITE_SIDECAR_TOKEN": JSON.stringify(""),
        }
      : {},
  build: {
    target: "es2022",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1500,
  },
}));
