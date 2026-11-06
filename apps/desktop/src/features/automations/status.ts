const labels: Record<string, string> = {
  pending: "等待开始",
  queued: "等待开始",
  running: "正在处理",
  planning: "正在整理计划",
  waiting_input: "等待你的选择",
  waiting_authorization: "需要你确认后继续",
  waiting_timer: "等待下次检查",
  retry_scheduled: "暂时未完成，等待重试",
  needs_attention: "需要处理后继续",
  unknown: "需要核实执行结果",
  completed: "已完成",
  cancelled: "已停止，已有成果保留",
  closed: "已归档",
  failed: "暂时未完成",
  awaiting_review: "等待验收",
};

export const automationStatusLabel = (status: string): string => labels[status] ?? "等待状态更新";

export const automationIsRunning = (status?: string): boolean => status === "running";
