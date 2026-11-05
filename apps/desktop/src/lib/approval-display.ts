import type { Approval } from "@agentdesk/shared";

type ApprovalDisplayInput = Pick<Approval, "title" | "detail" | "payload">;

export function humanActionTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const title = value.trim();
  // 模型可能把脚本放进用途字段；常规对话不得回退到执行原文。
  if (
    !title ||
    title.length > 100 ||
    /[`{}\n\r]|(?:node|python|bash|powershell)\s+-|console\.|require\(|import\s|命令[:：]/i.test(
      title,
    )
  )
    return fallback;
  return title;
}

export function chatActionDisplay(approval: Approval) {
  const payload =
    approval.payload && typeof approval.payload === "object"
      ? (approval.payload as Record<string, unknown>)
      : {};
  const args =
    payload.args && typeof payload.args === "object"
      ? (payload.args as Record<string, unknown>)
      : {};
  if (payload.tool === "shell.run" || /执行命令|命令[:：]/.test(approval.title + approval.detail)) {
    return {
      title: humanActionTitle(args.purpose, "继续完成当前任务"),
      detail: "下一步需要使用本机程序，可能创建或修改文件。是否继续？",
    };
  }
  const title = humanActionTitle(approval.title, "继续完成当前任务");
  const descriptions: Record<string, string> = {
    "fs.write": "将写入任务相关文件。是否继续？",
    "fs.patch": "将修改任务相关文件。是否继续？",
    "deploy.run": "将更新所选服务器上的应用。是否继续部署？",
    "disk.clean": "将清理已选中的文件。是否继续？",
    "projects.pull": "将更新本地项目文件。是否继续？",
    "browser.open": "将打开浏览器完成这项任务。是否继续？",
    "workflow.run": "将按已选择的流程执行任务。是否继续？",
    "memory.forget": "将删除这条已保存的记忆。是否继续？",
  };
  return {
    title,
    detail: descriptions[String(payload.tool)] ?? "下一步会对当前任务作出更改。是否继续？",
  };
}

export function approvalDisplay(input: ApprovalDisplayInput) {
  const payload =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : null;
  const args =
    payload?.args && typeof payload.args === "object"
      ? (payload.args as Record<string, unknown>)
      : null;
  if (payload?.tool === "shell.run" || input.title.startsWith("执行命令：")) {
    const purpose =
      typeof args?.purpose === "string" && args.purpose.trim()
        ? args.purpose.trim()
        : "执行本地命令";
    const command =
      typeof args?.command === "string" ? args.command : input.title.replace(/^执行命令：/, "");
    const cwd = typeof args?.cwd === "string" ? args.cwd : "默认工作目录";
    return {
      title: purpose,
      detail: "此操作会在你的电脑上运行，请确认符合当前任务。",
      technicalDetail: `命令：${command}\n工作目录：${cwd}`,
    };
  }
  return { title: input.title, detail: input.detail, technicalDetail: "" };
}
