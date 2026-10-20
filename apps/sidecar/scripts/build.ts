/**
 * 打包 sidecar 为可随安装包分发的目录：
 *   dist/index.mjs         esbuild 单文件 bundle
 *   dist/node.exe          当前 Node 运行时（与 better-sqlite3 原生模块 ABI 一致）
 *   dist/node_modules/...  无法 bundle 的原生/大体积依赖
 *   dist/skills/           内置 Skills
 */
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const EXTERNAL = ["better-sqlite3", "playwright-core"];

const SEARCH_BASES = [root, resolve(root, "../../packages/integrations")];

function packageDir(name: string, from: string): string {
  for (const base of [from, ...SEARCH_BASES]) {
    try {
      const require = createRequire(join(base, "package.json"));
      let dir = dirname(require.resolve(name));
      while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
      return dir;
    } catch {
      // 尝试下一个解析起点
    }
  }
  throw new Error(`无法解析依赖 ${name}`);
}

/**
 * 外部依赖的运行时闭包（better-sqlite3 的 prebuild-install 等只在安装期使用，不需要分发）。
 * 第二项为解析起点包名，用于在 pnpm 的隔离 node_modules 中找到间接依赖。
 */
const RUNTIME_PACKAGES: Array<[name: string, parent?: string]> = [
  ["better-sqlite3"],
  ["bindings", "better-sqlite3"],
  ["file-uri-to-path", "bindings"],
  ["playwright-core"],
];

function copyPackage(name: string, parentDir?: string): string {
  const src = realpathSync(packageDir(name, parentDir ?? root));
  cpSync(src, join(dist, "node_modules", name), {
    recursive: true,
    filter: (path) => {
      const rel = path.slice(src.length);
      return !/^[\\/](deps|src|docs|test)([\\/]|$)|\.(md|d\.ts|map|cc|h|gyp|gypi)$/i.test(rel);
    },
  });
  return src;
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(dist, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: EXTERNAL,
  minify: true,
  sourcemap: false,
  legalComments: "none",
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
  logLevel: "info",
});

const resolved = new Map<string, string>();
for (const [name, parent] of RUNTIME_PACKAGES)
  resolved.set(name, copyPackage(name, parent ? resolved.get(parent) : undefined));
cpSync(join(root, "skills"), join(dist, "skills"), { recursive: true });
cpSync(process.execPath, join(dist, process.platform === "win32" ? "node.exe" : "node"));

const size = (p: string) => `${(statSync(p).size / 1024 / 1024).toFixed(1)} MB`;
console.info(
  `sidecar 打包完成：index.mjs ${size(join(dist, "index.mjs"))}，node ${process.version}`,
);
