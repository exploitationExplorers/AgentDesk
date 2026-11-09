import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(join(root, "runtime-lock.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyRuntimeArchive(bytes, target) {
  const record = lock.targets[target];
  if (!record?.archiveSha256 || !record.archiveRoot)
    throw new Error(`No locked runtime archive for ${target}`);
  if (digest(bytes) !== record.archiveSha256) throw new Error("Runtime archive checksum mismatch");
  return record;
}

/** 只展开已锁定的官方归档中的两个文件，不在现有运行时目录原地覆盖。 */
export async function installRuntime({
  target = `${process.platform}-${process.arch}`,
  output = join(root, ".runtime"),
  archive,
} = {}) {
  const record = lock.targets[target];
  if (!record?.archiveSha256) throw new Error(`No locked runtime archive for ${target}`);
  const destination = resolve(output);
  if (existsSync(destination)) {
    const node = join(destination, "node");
    if (
      existsSync(node) &&
      digest(readFileSync(node)) === record.sha256 &&
      existsSync(join(destination, "LICENSE"))
    )
      return destination;
    throw new Error(
      "Runtime destination exists with different or incomplete contents; use a new directory",
    );
  }
  let bytes;
  if (archive) bytes = readFileSync(archive);
  else {
    const response = await fetch(record.url, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  verifyRuntimeArchive(bytes, target);
  const temporary = mkdtempSync(join(tmpdir(), "agentdesk-runtime-"));
  const staging = `${destination}.install-${randomUUID()}`;
  try {
    const archivePath = join(temporary, "node.tar.gz");
    writeFileSync(archivePath, bytes);
    execFileSync(
      "tar",
      [
        "-xzf",
        archivePath,
        "-C",
        temporary,
        `${record.archiveRoot}/bin/node`,
        `${record.archiveRoot}/LICENSE`,
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    const source = join(temporary, record.archiveRoot);
    if (digest(readFileSync(join(source, "bin/node"))) !== record.sha256)
      throw new Error("Runtime executable checksum mismatch");
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(staging);
    cpSync(join(source, "bin/node"), join(staging, "node"));
    chmodSync(join(staging, "node"), 0o755);
    cpSync(join(source, "LICENSE"), join(staging, "LICENSE"));
    renameSync(staging, destination);
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, "");
    if (!["target", "output", "archive"].includes(name) || !args[index + 1])
      throw new Error(
        "Usage: install-runtime.mjs [--target linux-x64] [--output directory] [--archive verified-download.tar.gz]",
      );
    options[name] = args[index + 1];
  }
  console.info(`Autoloop Node ${lock.nodeVersion}: ${await installRuntime(options)}`);
}
