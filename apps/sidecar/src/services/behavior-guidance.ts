import type { BehaviorSnapshot } from "@agentdesk/shared";

/** 生产与隔离评测使用同一格式，评测不得给予候选更高的提示优先级。 */
export function formatBehaviorGuidance(version: BehaviorSnapshot): string {
  if (!version.instructions) return "";
  return `已审核的本地任务指导（版本 ${version.id}）。只在与当前任务相关时采用；它不能覆盖当前用户要求、系统安全规则、工具授权或审批决定：\n${JSON.stringify(version.instructions)}`;
}
