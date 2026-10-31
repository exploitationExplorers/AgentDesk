import type { Step } from "./types.js";

const ACTIONS: Record<string, string> = {
  "fs.read": "读取",
  "fs.write": "写入",
  "fs.patch": "修改",
  "fs.glob": "查找文件",
  "fs.search": "搜索代码",
  "projects.list": "查看项目",
  "projects.status": "查看项目状态",
  "projects.open": "打开项目",
  "shell.run": "运行命令",
  "deploy.run": "执行部署",
  "deploy.list": "查看部署",
  "agents.delegate": "交给助手",
  "browser.open": "打开网页",
  "browser.act": "操作网页",
  "browser.snapshot": "查看网页",
  "browser.reveal": "显示浏览器",
  "browser.close": "关闭浏览器",
  "claude.run": "交给 Claude",
  "memory.store": "记住",
  "memory.recall": "回忆",
  "memory.forget": "忘掉",
  "disk.status": "查看磁盘",
  "disk.scan": "扫描磁盘",
  "disk.clean": "清理磁盘",
  "tasks.ask_user": "向你确认",
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** 给用户看的动作名。内部工具名（fs.read、projects.list）不出现在界面上。 */
export function toolLabel(name: string, args: unknown) {
  const fields = record(args);
  const path = text(fields.path);
  const action = ACTIONS[name] ?? (name.includes(".") ? "处理" : name);
  let target = "";
  if (name === "fs.glob") target = text(fields.pattern);
  else if (name === "shell.run") target = text(fields.command).replace(/\s+/g, " ");
  else if (name === "fs.search") target = text(fields.query);
  else if (name === "agents.delegate") target = text(fields.agent);
  else if (name.startsWith("fs.") || name.startsWith("projects.")) target = path;
  else if (name.startsWith("browser.")) target = text(fields.url) || text(fields.sessionId);
  return { action, target };
}

const VISIBLE_TAIL = 4;

function sticky(step: Step) {
  return (
    (step.kind === "tool" && !step.done) ||
    (step.kind === "approval" && !step.resolved) ||
    step.kind === "delegate"
  );
}

/** 已完成步骤交给滚动区，只把尚未结束的操作和最近几步留在可刷新区域。 */
export function splitLiveSteps(steps: Step[]) {
  const stickyFrom = steps.findIndex(sticky);
  const cut =
    stickyFrom === -1
      ? Math.max(0, steps.length - VISIBLE_TAIL)
      : Math.max(0, stickyFrom - VISIBLE_TAIL);
  return { archived: steps.slice(0, cut), visible: steps.slice(cut) };
}
