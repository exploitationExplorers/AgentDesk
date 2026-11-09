import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

const version = "0.167.0";
const integrity =
  "FNc7danfUng9Sp6w+Fh7kofNHHZpA6VMyNKWsWrS3OwHly69gywTWeiuwrUPXpJSho8Df4xqRsHfHRPzj7zYQg==";
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This release supports linux/amd64 only");
const destination = process.argv[2];
if (!destination) throw new Error("Pass a new installation directory");
const temporary = await mkdtemp(join(tmpdir(), "agentdesk-codex-install-"));
try {
  let source;
  if (process.argv[3] && existsSync(process.argv[3])) source = createReadStream(process.argv[3]);
  else {
    const response = await fetch(
      `https://registry.npmjs.org/@openai/codex/-/codex-${version}-linux-x64.tgz`,
      { signal: AbortSignal.timeout(600_000) },
    );
    if (!response.ok || !response.body) throw new Error("Codex download failed");
    source = Readable.fromWeb(response.body);
  }
  const archive = join(temporary, "codex.tgz"),
    digest = createHash("sha512");
  await pipeline(
    source,
    new Transform({
      transform(chunk, _encoding, callback) {
        digest.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(archive, { flags: "wx" }),
  );
  if (digest.digest("base64") !== integrity) throw new Error("Codex archive integrity mismatch");
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  if (entries.some((path) => !path.startsWith("package/") || path.split("/").includes("..")))
    throw new Error("Unsafe Codex archive");
  await mkdir(destination);
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", destination], {
    stdio: "inherit",
  });
  const vendor = join(destination, "vendor");
  const targets = (await readdir(vendor)).filter(
    (name) => name.startsWith("x86_64-") && name.includes("linux"),
  );
  if (targets.length !== 1) throw new Error("Ambiguous Codex platform directory");
  const binary = join(vendor, targets[0], "bin/codex");
  if (execFileSync(binary, ["--version"], { encoding: "utf8" }).trim() !== `codex-cli ${version}`)
    throw new Error("Codex binary version mismatch");
  await mkdir(join(destination, "bin"));
  await symlink(relative(join(destination, "bin"), binary), join(destination, "bin/codex"));
  const searchEntry = entries.find((path) => path.endsWith("/rg"));
  if (searchEntry) {
    const search = join(destination, searchEntry.slice("package/".length));
    await symlink(relative(join(destination, "bin"), search), join(destination, "bin/rg"));
  }
  console.info(`Installed verified Codex ${version} for linux/amd64`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
