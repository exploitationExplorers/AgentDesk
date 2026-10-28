import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecar = resolve(root, "../sidecar");
// 构建依赖来自 monorepo；发行包运行时只需要自身声明的外部依赖。
const requireBuild = createRequire(join(sidecar, "package.json"));
const { build } = requireBuild("esbuild");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const options = {
  bundle: true,
  platform: "node",
  target: "node22.12",
  format: "esm",
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
  jsx: "automatic",
};

await build({
  ...options,
  entryPoints: [join(root, "src/index.mjs")],
  outfile: join(dist, "index.mjs"),
  // Ink 仅在 DEV=true 且 devtools 可达时才真正调用该可选集成；单文件 bundle 下其静态 import
  // 仍会被 esbuild 提升解析，所以用空实现 shim 代替未安装的开发期依赖。
  alias: { "react-devtools-core": join(root, "scripts/shims/react-devtools-core.mjs") },
  // Ink 的依赖链（signal-exit 等，用于进程退出时恢复终端光标/状态）里有对 Node 内置模块
  // （assert/events）的 require() 调用；纯 ESM bundle 下 esbuild 把它转成 __require()，
  // 运行时没有真正的 require 可用就会抛 "Dynamic require of ... is not supported"，
  // 用和 runtime.mjs 同款的 banner 提供一个基于 createRequire 的真实 require。
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join("\n"),
  },
});
await build({
  ...options,
  entryPoints: [join(root, "src/runtime.ts")],
  outfile: join(dist, "runtime.mjs"),
  external: ["better-sqlite3", "playwright-core"],
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __fu(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join("\n"),
  },
});

const skills = JSON.parse(readFileSync(join(sidecar, "scripts/public-skills.json"), "utf8"));
for (const name of skills) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("公开技能名称无效。");
  cpSync(join(sidecar, "skills", name), join(dist, "skills", name), { recursive: true });
}
mkdirSync(join(dist, "scripts"), { recursive: true });
cpSync(join(sidecar, "scripts/ai-commit-worker.mjs"), join(dist, "scripts/ai-commit-worker.mjs"));
// 终端组件打入 bundle，同时保留其上游许可。
mkdirSync(join(dist, "licenses"), { recursive: true });
cpSync(
  join(root, "node_modules/@voidzero-dev/vite-plus-prompts/LICENSE"),
  join(dist, "licenses/vite-plus-prompts-LICENSE.txt"),
);
const requireCli = createRequire(join(root, "package.json"));
const requirePrompts = createRequire(requireCli.resolve("@voidzero-dev/vite-plus-prompts"));
for (const [name, license] of [
  ["@clack/core", "LICENSE"],
  ["picocolors", "LICENSE"],
  ["sisteransi", "license"],
]) {
  let packageRoot = dirname(requirePrompts.resolve(name));
  while (!existsSync(join(packageRoot, "package.json"))) {
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw new Error(`找不到 ${name} 的许可目录。`);
    packageRoot = parent;
  }
  cpSync(
    join(packageRoot, license),
    join(dist, "licenses", `${name.replaceAll(/[@/]/g, "-")}-LICENSE.txt`),
  );
}
// Ink 交互式会话打入 bundle 的纯 JS 依赖，同样保留其上游许可。
for (const [name, license] of [
  ["ink", "license"],
  ["ink-text-input", "license"],
  ["marked", "LICENSE.md"],
  ["marked-terminal", "LICENSE"],
  ["react", "LICENSE"],
]) {
  cpSync(
    join(root, "node_modules", name, license),
    join(dist, "licenses", `${name.replaceAll(/[@/]/g, "-")}-LICENSE.txt`),
  );
}
console.info("CLI 发行文件已生成；Node 与原生依赖由安装目标提供。");
