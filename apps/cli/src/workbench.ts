import { spawn } from "node:child_process";
import { apiRequest } from "./client.js";
import { runningState } from "./lifecycle.js";
import { select } from "./terminal.js";
import { createUi, nextCommand } from "./ui.js";

export async function openBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("仅允许打开本机工作台地址。");
  }
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timeout = setTimeout(() => {
      child.unref();
      reject(new Error("浏览器打开超时"));
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("无法打开默认浏览器"));
    });
  });
}

export async function openWorkbench(
  home: string,
  workerPath: string,
  { noOpen = false, json = false, launch = openBrowser } = {},
): Promise<void> {
  const state = await runningState(home, workerPath);
  let link: { path: string; expiresAt: number };
  try {
    link = await (
      await apiRequest<{ path: string; expiresAt: number }>(state, "/cli/web-session", {
        method: "POST",
        body: "{}",
      })
    ).json();
  } catch (error) {
    throw new Error(
      `无法打开工作台：${error instanceof Error ? error.message : String(error)}。如果刚升级 CLI，请先执行 ${nextCommand("restart", home)}。`,
    );
  }
  const origin = `http://127.0.0.1:${state.port}`;
  const url = new URL(link.path, origin);
  if (
    url.origin !== origin ||
    url.pathname !== "/connect" ||
    !/^#ticket=[a-f0-9]{64}$/.test(url.hash)
  )
    throw new Error("工作台返回了无效的连接地址。");
  // 自动化输出保持单个 JSON，不启动桌面程序。
  if (json) {
    console.info(JSON.stringify({ url: url.href, expiresAt: link.expiresAt }));
    return;
  }
  const ui = createUi();
  ui.header("浏览器工作台");
  ui.note("与当前 CLI 共用模型、对话和任务，关闭此终端后仍可使用。");
  let opened = false;
  if (!noOpen) {
    try {
      await launch(url.href);
      opened = true;
    } catch {
      ui.note("未能自动打开浏览器，请复制下面的连接地址。");
    }
  }
  if (opened) ui.success(`已打开工作台：${origin}`);
  else {
    console.info(url.href);
    ui.note("此连接地址 2 分钟内有效且只能使用一次，请勿分享。");
  }
  ui.note(`重新打开：${nextCommand("web", home)}`);
  ui.note(`停止本机服务：${nextCommand("stop", home)}`);
}

/** 初始化完成后提供产品入口，显式 chat 命令仍直接进入对话。 */
export async function chooseWorkspace(home: string, workerPath: string): Promise<"chat" | "web"> {
  const ui = createUi();
  ui.note(`浏览器工作台与终端对话共用数据。随时运行 ${nextCommand("web", home)} 打开工作台。`);
  ui.note("桌面模式请打开已安装的 AgentDesk 应用，桌面端使用独立数据目录。");
  const mode = await select("接下来在哪里使用 AgentDesk？", [
    { value: "web", label: "打开浏览器工作台", hint: "查看编码现场、项目、任务与设置" },
    { value: "chat", label: "继续终端对话", hint: "在当前终端与 Agent 协作" },
  ]);
  if (mode === "web") {
    await openWorkbench(home, workerPath);
    return "web";
  }
  return "chat";
}
