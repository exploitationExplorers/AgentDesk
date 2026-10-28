/**
 * 针对构建产物 dist/index.mjs 的挂载期回归闸门：验证真实交互式 chat 在没有人按键的情况下，
 * Ink 确实挂载并产出了画面，而不是静默卡死（"Detected unsettled top-level await"，exit 13）。
 *
 * 不随 `node --test test/*.test.mjs` 自动运行——和 package-smoke.mjs 同一个理由，这个文件依赖
 * 先 `pnpm build:cli` 生成的真实构建产物，不能假设它在任意时刻都已经存在。按 package-smoke.mjs
 * 的既定做法单独调用：`pnpm build:cli && node --test apps/cli/test/interactive-dist-smoke.mjs`。
 *
 * 用法 2（`fake-tty-probe.mjs` 伪造 isTTY + 空 setRawMode）起一个真实子进程、硬超时包住，断言
 * stdout 在超时窗口内出现了已知一定会渲染出来的 UI 文案，而不是"完全没有输出就超时"。不验证
 * 真实按键交互——那需要真实终端，这里只验证挂载本身没有卡死。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const entry = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
assert.ok(existsSync(entry), "请先执行 pnpm build:cli 生成构建产物。");
const probe = fileURLToPath(new URL("./fixtures/fake-tty-probe.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "agentdesk-interactive-dist-smoke-"));

function run(args, { timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, "--data-dir", home], {
      cwd: home,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时：${args[0]}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`命令 ${args[0]} 退出 ${code}：${stderr || stdout}`));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Ink 挂载后一定会渲染 StatusBar/InputBar 的固定文案（不依赖是否配置了模型、是否有历史会话）。
 * 用一个硬超时窗口等待这段输出出现；超时意味着挂载阶段卡死（本测试要防止的真实问题），不是
 * "再等久一点就会出现"——挂载要么在几秒内完成，要么就是卡死了。
 */
function waitForInkMount(child, needles, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `等待 Ink 挂载输出超时（${timeoutMs}ms）：挂载阶段可能卡死。已收到 stdout：${JSON.stringify(stdout)}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (needles.every((needle) => stdout.includes(needle))) {
        clearTimeout(timer);
        child.kill();
        resolve(stdout);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal) return;
      reject(
        new Error(
          `探针进程提前退出（code=${code}），挂载未完成。stdout：${JSON.stringify(stdout)}`,
        ),
      );
    });
  });
}

try {
  await run(["start", "--port", "0"]);
  const child = spawn(process.execPath, [probe, entry, "chat", "--data-dir", home], {
    cwd: home,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // "空闲" 来自 StatusBar 的状态文案，"输入消息" 来自 InputBar 的占位提示：两者都只在 Ink
    // 真正完成首次渲染后才会出现在 stdout 上，不依赖模型配置或历史会话是否存在。
    await waitForInkMount(child, ["空闲", "输入消息"], 10_000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  console.info(JSON.stringify({ ok: true, check: "interactive-dist-mount" }, null, 2));
} finally {
  await run(["stop"]).catch(() => {});
}
