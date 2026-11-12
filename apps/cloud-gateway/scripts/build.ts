import { build } from "esbuild";
import { cp, mkdir, stat } from "node:fs/promises";

// 完整构建必须包含真实手机产物，缺失时明确失败，避免发布只有 API 的入口。
await stat("../desktop/dist-cloud/cloud.html");

await build({
  entryPoints: { server: "src/index.ts", recover: "src/recover.ts", migrate: "src/migrate.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  sourcemap: true,
  external: ["better-auth", "better-auth/*", "better-sqlite3", "nodemailer", "pg"],
});
await mkdir("dist/public", { recursive: true });
await cp("../desktop/dist-cloud", "dist/public", { recursive: true });
