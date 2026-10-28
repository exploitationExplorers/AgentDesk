#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP, parseCommand } from "./args.mjs";
import { apiRequest } from "./client.mjs";
import {
  cancelTaskCommand,
  chat,
  doctor,
  initialize,
  inspectTask,
  listTasks,
  logs,
  resumeTask,
  runTask,
} from "./commands.mjs";
import { runningState, serviceStatus, startService, stopService } from "./lifecycle.mjs";
import { cliHome } from "./state.mjs";
import { configureUi, createUi, nextCommand } from "./ui.mjs";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const workerPath = fileURLToPath(new URL("./runtime.mjs", import.meta.url));

async function main() {
  const { command, values, positionals } = parseCommand(process.argv.slice(2));
  configureUi(values);
  const ui = createUi({ stream: process.stdout });
  if (command === "version") {
    console.info(VERSION);
    return;
  }
  const home = cliHome(values["data-dir"]);
  // 裸执行（无子命令、真实交互终端）：已配置模型直接进对话，否则先走配置向导再无缝接续，
  // 跳过 HELP。非 TTY/管道场景不满足三流 TTY 条件，原样回落到下面的 help 分支打印 HELP。
  const bareInteractive =
    process.argv.length === 2 &&
    process.stdin.isTTY &&
    process.stderr.isTTY &&
    process.stdout.isTTY;
  if (bareInteractive) {
    const state = await runningState(home, workerPath);
    const providers = await (await apiRequest(state, "/providers")).json();
    if (!providers.some((p) => p.enabled))
      await initialize(home, workerPath, values, { version: VERSION });
    const { runInteractiveChat } = await import("./interactive/session.mjs");
    await runInteractiveChat(home, workerPath, values);
    return;
  }
  if (values.help || command === "help") {
    if (ui.interactive) {
      if (process.argv.length === 2) await ui.welcome("从一个想法开始", VERSION);
      else ui.header("你的本地 Agent 工作台", VERSION);
    }
    process.stdout.write(HELP);
    return;
  }
  if (command === "start" || command === "restart") {
    let port = values.port === undefined ? undefined : Number(values.port);
    if (command === "restart") {
      const old = await serviceStatus(home);
      port ??= old.state?.port || undefined;
      await stopService(home);
    }
    const start = () => startService(home, { workerPath, port, foreground: values.foreground });
    const result = values.foreground
      ? await start()
      : await createUi().task("正在启动本地引擎…", start);
    if (result.status === "running") {
      ui.header("你的本地 Agent 工作台", VERSION);
      ui.success(result.existing ? "服务已在运行" : "服务已启动");
      ui.card("本地实例", [
        ["服务", `http://127.0.0.1:${result.state.port}`],
        ["进程", `PID ${result.state.pid}`],
        ["数据", home],
      ]);
      ui.note(`配置模型：${nextCommand("init", home)}`);
      ui.note(`开始对话：${nextCommand('chat "你好"', home)}`);
      ui.outro("本地引擎已就绪");
    }
  } else if (command === "stop") {
    const stopped = await createUi().task("正在停止本地引擎…", () => stopService(home));
    ui.success(stopped ? "服务已停止。" : "服务未运行。");
  } else if (command === "status") {
    const result = await serviceStatus(home);
    const output = {
      status: result.status,
      pid: result.state?.pid,
      port: result.state?.port,
      mode: result.state?.mode,
      version: result.instance?.version,
      home,
    };
    if (values.json) console.info(JSON.stringify(output, null, 2));
    else {
      const labels = {
        running: "运行中",
        stopped: "已停止",
        starting: "启动中",
        unreachable: "暂时无法连接",
      };
      ui.card("实例状态", [
        ["状态", `${labels[output.status] ?? output.status} (${output.status})`],
        ["进程", output.pid ? `PID ${output.pid}` : "—"],
        ["服务", output.port ? `http://127.0.0.1:${output.port}` : "—"],
        ["数据", home],
      ]);
      ui.note(nextCommand(result.status === "running" ? "doctor" : "start", home));
      ui.outro(result.status === "running" ? "本地引擎已就绪" : "执行上方命令继续");
    }
    if (result.status !== "running") process.exitCode = 1;
  } else if (command === "logs") await logs(home, values);
  else if (command === "doctor") {
    if (!(await doctor(home, workerPath, values.json))) process.exitCode = 1;
  } else if (command === "init") await initialize(home, workerPath, values, { version: VERSION });
  else if (command === "chat") {
    const message = positionals.join(" ").trim();
    const interactive =
      !message &&
      !values.json &&
      process.stdin.isTTY &&
      process.stderr.isTTY &&
      process.stdout.isTTY;
    if (interactive) {
      // 动态导入：避免 help/status 等其他命令在运行未打包源码时加载 Ink/JSX 组件树。
      const { runInteractiveChat } = await import("./interactive/session.mjs");
      await runInteractiveChat(home, workerPath, values);
    } else await chat(home, workerPath, message, values);
  } else if (command === "run") {
    const goal = positionals.join(" ").trim();
    const interactive =
      !values.json && process.stdin.isTTY && process.stderr.isTTY && process.stdout.isTTY;
    if (interactive) {
      const { runInteractiveTask } = await import("./interactive/task-session.mjs");
      await runInteractiveTask(home, workerPath, goal, values);
    } else await runTask(home, workerPath, goal, values);
  } else if (command === "tasks") await listTasks(home, workerPath, values);
  else if (command === "inspect") {
    const interactive =
      values.follow &&
      !values.json &&
      process.stdin.isTTY &&
      process.stderr.isTTY &&
      process.stdout.isTTY;
    if (interactive) {
      const { runInteractiveInspect } = await import("./interactive/task-session.mjs");
      await runInteractiveInspect(home, workerPath, positionals[0], values);
    } else await inspectTask(home, workerPath, positionals[0], values);
  } else if (command === "cancel")
    await cancelTaskCommand(home, workerPath, positionals[0], values);
  else if (command === "resume") {
    const interactive =
      !values.json && process.stdin.isTTY && process.stderr.isTTY && process.stdout.isTTY;
    if (interactive) {
      const { runInteractiveResume } = await import("./interactive/task-session.mjs");
      await runInteractiveResume(home, workerPath, positionals[0], values);
    } else await resumeTask(home, workerPath, positionals[0], values);
  } else {
    const state = await runningState(home, workerPath);
    if (command === "approvals") {
      const approvals = await (await apiRequest(state, "/approvals?status=pending")).json();
      if (values.json) console.info(JSON.stringify(approvals, null, 2));
      else if (!approvals.length) console.info("暂无待处理审批。");
      else
        for (const item of approvals)
          console.info(`${item.id} [${item.risk}] ${item.title}\n${item.detail}`);
    } else {
      await apiRequest(state, `/approvals/${encodeURIComponent(positionals[0])}`, {
        method: "POST",
        body: JSON.stringify({ approved: command === "approve" }),
      });
      console.info(command === "approve" ? "已批准。" : "已拒绝。");
    }
  }
}

await main().catch((error) => {
  if (error instanceof Error && error.message === "已取消配置。")
    createUi().outro("配置已取消，未保存本次输入。", { cancelled: true });
  else createUi().error(`AgentDesk：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
