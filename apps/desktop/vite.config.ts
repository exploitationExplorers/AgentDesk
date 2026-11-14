import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
const root = dirname(fileURLToPath(import.meta.url));

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
    mode === "cli" || mode === "team"
      ? {
          "import.meta.env.VITE_AGENTDESK_MODE": JSON.stringify(mode),
          "import.meta.env.VITE_SIDECAR_URL": JSON.stringify(""),
          "import.meta.env.VITE_SIDECAR_TOKEN": JSON.stringify(""),
        }
      : {},
  build: {
    target: "es2022",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 3500,
    // WorkBuddy 同款：独立 /slide/pc.html 供 iframe 嵌入 PPT 编辑器。
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        slide: resolve(root, "slide/pc.html"),
      },
    },
  },
}));
