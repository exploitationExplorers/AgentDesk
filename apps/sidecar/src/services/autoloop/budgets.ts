import type { DurableCheckpoint } from "@agentdesk/agent-core";
import { AppError, ErrorCode, type AutomationBinding } from "@agentdesk/shared";

export function checkpointUsage(checkpoint?: DurableCheckpoint): {
  tokens: number | null;
  costUsd: number | null;
} {
  let tokens = 0;
  let costUsd = 0;
  let priced = true;
  let counted = true;
  for (const message of checkpoint?.messages ?? []) {
    if (message.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage || !Number.isFinite(usage.totalTokens) || usage.totalTokens <= 0) {
      priced = false;
      counted = false;
      continue;
    }
    tokens += usage.totalTokens;
    // 未配置价格的 Provider 常返回 0；不能将其当成免费用量。
    if (usage.totalTokens > 0 && (!Number.isFinite(usage.cost?.total) || usage.cost.total <= 0))
      priced = false;
    else costUsd += usage.cost?.total ?? 0;
  }
  return { tokens: counted ? tokens : null, costUsd: priced ? costUsd : null };
}

export function assertBudget(binding: AutomationBinding, checkpoint?: DurableCheckpoint): void {
  const usage = checkpointUsage(checkpoint);
  if (
    binding.maxTokens !== undefined &&
    (usage.tokens === null || usage.tokens >= binding.maxTokens)
  )
    throw new AppError(
      ErrorCode.Conflict,
      usage.tokens === null
        ? "模型未提供可靠用量，已停止后续执行"
        : "已达到 Token 预算，已有执行记录已保留",
    );
  if (
    binding.maxCostUsd !== undefined &&
    (usage.costUsd === null || usage.costUsd >= binding.maxCostUsd)
  )
    throw new AppError(
      ErrorCode.Conflict,
      usage.costUsd === null
        ? "模型未提供可靠费用，已停止后续执行"
        : "已达到费用预算，已有执行记录已保留",
    );
}
