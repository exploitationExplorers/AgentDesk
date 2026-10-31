/**
 * 针对构建产物 dist/index.mjs 的挂载期回归闸门：验证真实交互式 chat 在没有人按键的情况下，
 * Ink 确实挂载并产出了画面，而不是静默卡死（"Detected unsettled top-level await"，exit 13）。
 *
 * 不随单元测试自动运行：此文件依赖 `pnpm build:cli` 生成的真实构建产物。
 * 构建后单独调用：`pnpm --filter @agentdesk/cli test:dist`。
 *
 * 用法 2（`fake-tty-probe.mjs` 伪造 isTTY + 空 setRawMode）起一个真实子进程、硬超时包住，断言
 * stdout 在超时窗口内出现了已知一定会渲染出来的 UI 文案，而不是"完全没有输出就超时"。不验证
 * 真实按键交互——那需要真实终端，这里只验证挂载本身没有卡死。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const entry = process.argv[2]
  ? join(resolve(process.argv[2]), "dist/index.mjs")
  : fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
assert.ok(existsSync(entry), "请先执行 pnpm build:cli 生成构建产物。");
const probe = fileURLToPath(new URL("./fixtures/fake-tty-probe.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "agentdesk-interactive-dist-smoke-"));

function run(
  args: string[],
  { timeoutMs = 25_000 } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, "--data-dir", home], {
      cwd: home,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTDESK_SMOKE_KEY: "local-menu-smoke", AGENTDESK_SKIP_UPDATE: "1" },
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
function waitForInkMount(
  child: ChildProcessByStdio<Writable | null, Readable, Readable>,
  needles: string[],
  timeoutMs: number,
): Promise<string> {
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

/** 对发行包注入真实输入字节，验证菜单、会话切换和 Ctrl+C 的输入分发。 */
async function checkSlashCommands() {
  const child = spawn(process.execPath, [probe, entry, "chat", "--data-dir", home], {
    cwd: home,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDESK_SKIP_UPDATE: "1" },
  });
  // 等到输入回显后再发送 Enter，避免繁忙进程将紧邻的数据块当成一次多行粘贴。
  const commandSteps = (command: string) => [
    { needle: `› ${command}`, action: () => child.stdin.write("\r") },
  ];
  const steps = [
    { needle: "空闲", action: () => child.stdin.write("/model") },
    ...commandSteps("/model"),
    { needle: "选择模型", action: () => child.stdin.write("\x1b[B") },
    { needle: "❯ menu-smoke", action: () => child.stdin.write("\r") },
    { needle: "当前会话已切换到 menu-smoke", action: () => child.stdin.write("/model info") },
    ...commandSteps("/model info"),
    {
      needle: "当前模型：menu-smoke",
      action: () => child.stdin.write("discard-draft"),
    },
    { needle: "› discard-draft", action: () => child.stdin.write("\x03") },
    { needle: "输入消息，或 / 查看指令", action: () => child.stdin.write("/version") },
    ...commandSteps("/version"),
    { needle: "AgentDesk v", action: () => child.stdin.write("/clear") },
    ...commandSteps("/clear"),
    { needle: "已开始新会话", action: () => child.stdin.write("/help") },
    ...commandSteps("/help"),
    { needle: "命令与快捷键", action: () => child.stdin.write("\x1b") },
    { needle: "输入消息，或 / 查看指令", action: () => child.stdin.write("/exit") },
    ...commandSteps("/exit"),
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      let stage = 0;
      let screen = "";
      let stderr = "";
      const updates: string[] = [];
      let actionPending = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `指令交互超时，步骤 ${stage}：${screen}\n${stderr}\n${updates.slice(-20).join("\n")}`,
          ),
        );
      }, 12_000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        updates.push(`${stage}: ${JSON.stringify(chunk.toString())}`);
        if (updates.length > 20) updates.shift();
        // 增量刷新可能把同一帧拆成多块；发出按键前的后续块不属于下一步响应。
        if (actionPending) return;
        screen += stripVTControlCharacters(chunk.toString());
        const step = steps[stage];
        if (step && screen.includes(step.needle)) {
          stage += 1;
          screen = "";
          actionPending = true;
          setTimeout(() => {
            actionPending = false;
            step.action();
          }, 40);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && stage === steps.length) resolve();
        else
          reject(new Error(`指令交互提前结束：code=${code}, stage=${stage}\n${screen}\n${stderr}`));
      });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

try {
  await run(["start", "--port", "0"]);
  const child = spawn(process.execPath, [probe, entry, "chat", "--data-dir", home], {
    cwd: home,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // "空闲" 来自 StatusBar，"AgentDesk" 来自启动区：两者都只在 Ink
    // 真正完成首次渲染后才会出现在 stdout 上，不依赖模型配置或历史会话是否存在。
    await waitForInkMount(child, ["空闲", "AgentDesk", "浏览器工作台", "agentdesk web"], 10_000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await run([
    "init",
    "--base-url",
    "http://127.0.0.1:1/v1",
    "--model",
    "menu-smoke",
    "--api-key-env",
    "AGENTDESK_SMOKE_KEY",
  ]);
  await checkSlashCommands();
  const guided = spawn(process.execPath, [probe, entry, "init", "--plain", "--data-dir", home], {
    cwd: home,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENTDESK_SKIP_UPDATE: "1" },
  });
  let prompts = "";
  let stage = 0;
  guided.stderr.on("data", (chunk) => {
    prompts += chunk;
    if (stage === 0 && prompts.includes("1. 保留当前配置") && prompts.includes("请选择")) {
      stage = 1;
      prompts = "";
      setTimeout(() => guided.stdin.write("1\n"), 30);
    } else if (stage === 1 && prompts.includes("2. 继续终端对话") && prompts.includes("请选择")) {
      assert.ok(prompts.includes("1. 打开浏览器工作台"));
      stage = 2;
      setTimeout(() => guided.stdin.write("2\n"), 30);
    }
  });
  try {
    await waitForInkMount(guided, ["空闲", "浏览器工作台", "agentdesk web"], 10_000);
    assert.equal(stage, 2, "初始化后需要展示工作台选择并允许继续终端对话");
  } finally {
    if (guided.exitCode === null && guided.signalCode === null) guided.kill();
  }
  console.info(JSON.stringify({ ok: true, check: "interactive-dist-mount" }, null, 2));
} finally {
  await run(["stop"]).catch(() => {});
}
