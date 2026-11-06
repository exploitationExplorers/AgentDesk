import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_NODE = "24.11.1";

/** sidecar 与 CLI 构建共用；Hub 自带 Node，与 better-sqlite3 的 ABI 分离。 */
export function copyAutoloopRuntime(targetDirectory, options = {}) {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const node =
    options.nodePath ?? process.env.AGENTDESK_AUTOLOOP_NODE ?? join(root, ".runtime", executable);
  if (!existsSync(node))
    throw new Error(
      `缺少 Autoloop Node ${PINNED_NODE}。请将官方目标平台运行时放入 ${node}，或设置 AGENTDESK_AUTOLOOP_NODE。`,
    );
  const runtimeLock = JSON.parse(readFileSync(join(root, "runtime-lock.json"), "utf8"));
  const lockedTarget = runtimeLock.targets[`${process.platform}-${process.arch}`];
  if (!lockedTarget || runtimeLock.nodeVersion !== PINNED_NODE)
    throw new Error(`Autoloop 尚未锁定 ${process.platform} / ${process.arch} 的发行运行时`);
  if (createHash("sha256").update(readFileSync(node)).digest("hex") !== lockedTarget.sha256)
    throw new Error("Autoloop Node 运行时与官方 SHA256 不匹配");
  const probe = JSON.parse(
    execFileSync(
      node,
      [
        "-p",
        "JSON.stringify({nodeVersion:process.versions.node,sqliteVersion:process.versions.sqlite,modules:process.versions.modules,platform:process.platform,arch:process.arch})",
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  if (
    probe.nodeVersion !== PINNED_NODE ||
    probe.platform !== process.platform ||
    probe.arch !== process.arch
  )
    throw new Error(
      `Autoloop 必须使用 ${PINNED_NODE} / ${process.platform} / ${process.arch}，实际为 ${probe.nodeVersion} / ${probe.platform} / ${probe.arch}`,
    );
  mkdirSync(targetDirectory, { recursive: true });
  const upstream = JSON.parse(readFileSync(join(root, "upstream-manifest.json"), "utf8"));
  for (const [file, hashes] of Object.entries(upstream.files)) {
    if (
      createHash("sha256")
        .update(readFileSync(join(root, "vendor", file)))
        .digest("hex") !== hashes.sha256
    )
      throw new Error(`Autoloop 上游文件未匹配补丁清单：${file}`);
  }
  for (const file of ["LICENSE.upstream", "upstream-manifest.json", "runtime-lock.json"])
    cpSync(join(root, file), join(targetDirectory, file));
  cpSync(join(root, "vendor"), join(targetDirectory, "vendor"), { recursive: true });
  // npm 安装目录位于 node_modules；Node 不在那里剥除 TS。保留模块目录，
  // 使上游以 import.meta.url 定位 SQL/JSON 资源的语义在编译后保持一致。
  const rewriteImports = (source) =>
    source.replace(/\b(from\s+|import\s*\(\s*)(["'])(\.[^"']+)\.ts\2/g, "$1$2$3.mjs$2");
  writeFileSync(
    join(targetDirectory, "host.mjs"),
    rewriteImports(readFileSync(join(root, "host.mjs"), "utf8")),
  );
  for (const file of Object.keys(upstream.files).filter((path) => path.endsWith(".ts"))) {
    const source = rewriteImports(readFileSync(join(root, "vendor", file), "utf8"));
    const result = transformSync(source, {
      loader: "ts",
      format: "esm",
      target: "node24",
      legalComments: "eof",
    });
    writeFileSync(join(targetDirectory, "vendor", file.replace(/\.ts$/, ".mjs")), result.code);
  }
  cpSync(join(root, "patches"), join(targetDirectory, "patches"), { recursive: true });
  cpSync(node, join(targetDirectory, executable));
  const license = join(dirname(node), "LICENSE");
  if (!existsSync(license)) throw new Error("Autoloop Node 运行时必须附带官方 LICENSE");
  cpSync(license, join(targetDirectory, "Node-LICENSE.txt"));
  if (process.platform === "win32") {
    const supervisor = resolve(root, "../../crates/agentdesk-supervisor");
    execFileSync(
      "cargo",
      ["build", "--manifest-path", join(supervisor, "Cargo.toml"), "--release", "--locked"],
      { windowsHide: true, stdio: "inherit" },
    );
    cpSync(
      join(supervisor, "target/release/agentdesk-supervisor.exe"),
      join(targetDirectory, "agentdesk-supervisor.exe"),
    );
  }
  const files = {};
  const visit = (directory, prefix = "") => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const key = `${prefix}${item.name}`;
      if (item.isDirectory()) visit(join(directory, item.name), `${key}/`);
      else if (item.name !== "runtime-manifest.json")
        files[key] = createHash("sha256")
          .update(readFileSync(join(directory, item.name)))
          .digest("hex");
    }
  };
  visit(targetDirectory);
  const manifest = {
    schemaVersion: 1,
    upstreamCommit: "22312e16419fc9f542a58044cfbb76f4aec80623",
    ...probe,
    files,
  };
  writeFileSync(
    join(targetDirectory, "runtime-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = copyAutoloopRuntime(join(root, "dist"));
  console.info(`Autoloop Hub 已打包：Node ${result.nodeVersion} / SQLite ${result.sqliteVersion}`);
}
