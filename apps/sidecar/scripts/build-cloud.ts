import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-cloud");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: {
    cloud: join(root, "src/cloud.ts"),
    "migrate-runner": join(root, "src/migrate-runner.ts"),
  },
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3", "playwright-core"],
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

const searchBases = [root, resolve(root, "../../packages/integrations")];
function locatePackage(name: string, from?: string): string {
  for (const base of [from ?? root, ...searchBases]) {
    try {
      const require = createRequire(join(base, "package.json"));
      let dir = dirname(require.resolve(name));
      while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
      return realpathSync(dir);
    } catch {
      continue;
    }
  }
  throw new Error(`Unable to resolve runtime package ${name}`);
}

mkdirSync(join(dist, "node_modules"), { recursive: true });
const copied = new Map<string, string>();
for (const [name, parent] of [
  ["better-sqlite3", undefined],
  ["bindings", "better-sqlite3"],
  ["file-uri-to-path", "bindings"],
  ["playwright-core", undefined],
] as Array<[string, string | undefined]>) {
  const source = locatePackage(name, parent ? copied.get(parent) : undefined);
  cpSync(source, join(dist, "node_modules", name), { recursive: true });
  copied.set(name, source);
}
