import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "../../.tmp/team-client-20261114/package");
mkdirSync(join(output, "licenses"), { recursive: true });
await build({
  entryPoints: [join(root, "src/team/standalone.ts")],
  outfile: join(output, "client.mjs"),
  bundle: true,
  platform: "node",
  target: "node22.12",
  format: "esm",
  legalComments: "eof",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  metafile: true,
}).then((result) => {
  writeFileSync(join(output, "../build-manifest.json"), JSON.stringify(result.metafile, null, 2));
});
writeFileSync(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: "agentdesk-team-client",
      version: "0.1.0-preview.20261114",
      private: true,
      type: "module",
      license: "UNLICENSED",
      bin: { "agentdesk-team": "client.mjs" },
      engines: { node: ">=22.12.0" },
      files: ["client.mjs", "runner.example.json", "licenses"],
    },
    null,
    2,
  ),
);
cpSync(join(root, "../../deploy/team/runner.example.json"), join(output, "runner.example.json"));
const requireCli = createRequire(join(root, "package.json"));
const requirePrompts = createRequire(requireCli.resolve("@voidzero-dev/vite-plus-prompts"));
for (const [name, license] of [
  ["@voidzero-dev/vite-plus-prompts", "LICENSE"],
  ["@clack/core", "LICENSE"],
  ["picocolors", "LICENSE"],
  ["sisteransi", "license"],
  ["zod", "LICENSE"],
] as const) {
  const requirePackage = name === "zod" ? requireCli : requirePrompts;
  let packageRoot = dirname(requirePackage.resolve(name));
  while (!existsSync(join(packageRoot, "package.json"))) {
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw new Error(`找不到 ${name} 许可目录`);
    packageRoot = parent;
  }
  cpSync(
    join(packageRoot, license),
    join(output, "licenses", `${name.replaceAll(/[@/]/g, "-")}.txt`),
  );
}
console.info(output);
