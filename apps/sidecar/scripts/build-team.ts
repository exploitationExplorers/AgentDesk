import { cpSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist-team");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(root, "src/team.ts")],
  outfile: join(dist, "team.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3"],
  banner: {
    js: "import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);",
  },
});
const copied = new Set<string>();
function copyPackage(name: string, from: string) {
  if (isBuiltin(name)) return;
  if (copied.has(name)) return;
  copied.add(name);
  const require = createRequire(join(from, "package.json"));
  let directory = dirname(require.resolve(name));
  while (!existsSync(join(directory, "package.json"))) directory = dirname(directory);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  cpSync(directory, join(dist, "node_modules", name), { recursive: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyPackage(dependency, directory);
}
copyPackage("better-sqlite3", root);
const web = resolve(root, "../desktop/dist-team");
if (!existsSync(join(web, "index.html"))) throw new Error("Build desktop build:team first");
cpSync(web, join(dist, "web"), { recursive: true });
