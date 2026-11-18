import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const git = (...args) =>
  execFileSync("git", ["-c", `safe.directory=${root}`, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

try {
  const version = JSON.parse(read("package.json")).version;
  if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version))
    throw new Error("产品版本必须为 SemVer，如 1.0.0-alpha.1。");
  const versions = [
    JSON.parse(read("apps/desktop/package.json")).version,
    JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version,
    /^version = "([^"]+)"$/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1],
    /\[\[package\]\]\s+name = "agentdesk"\s+version = "([^"]+)"/.exec(
      read("apps/desktop/src-tauri/Cargo.lock"),
    )?.[1],
  ];
  if (versions.some((value) => value !== version))
    throw new Error("产品、desktop、Tauri 与 Cargo 版本不一致。");
  const changelog = read("CHANGELOG.md");
  if (!changelog.includes(`## [${version}] - `) || !changelog.includes(`tag \`v${version}\``))
    throw new Error("CHANGELOG 缺少当前版本的日期或 tag 记录。");
  const tag = `v${version}`;
  const existing = git("tag", "--list", tag);
  if (existing && git("rev-list", "-n", "1", tag) !== git("rev-parse", "HEAD"))
    throw new Error(`${tag} 已存在且不指向当前提交；不会覆盖旧 tag。`);
  if (existing && git("cat-file", "-t", `refs/tags/${tag}`) !== "tag")
    throw new Error(`${tag} 必须是 annotated tag。`);
  console.info(`版本检查通过：${version}，目标 tag ${tag}。CLI 和内部包独立版本化。`);
  if (process.argv.includes("--tag")) {
    if (git("status", "--porcelain"))
      throw new Error("工作区存在未提交改动，请先完成验证并提交后再打 tag。");
    if (existing) console.info(`${tag} 已存在并指向当前提交。`);
    else {
      git("tag", "-a", tag, "-m", `AgentDesk ${version}`);
      console.info(`已创建本地 annotated tag：${tag}。未推送或发布安装包。`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "发布检查失败。");
  process.exitCode = 1;
}
