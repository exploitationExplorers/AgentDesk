import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./welcome/", import.meta.url)),
  plugins: [react()],
  publicDir: "../public",
  envPrefix: "AGENTDESK_PUBLIC_WELCOME_",
  build: { outDir: "../dist-welcome", emptyOutDir: true, target: "es2022" },
});
