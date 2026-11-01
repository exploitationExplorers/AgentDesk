import { completeStructured, type ModelResolver } from "@agentdesk/agent-core";
import { z } from "zod";

const Verdict = z.object({ safe: z.boolean(), reason: z.string().max(80) });

/**
 * 对被判定为 dangerous 的 shell 命令做一次低成本复核：是否是已知安全模式的变体。
 * 任何失败（模型不可用、超时、输出不合法）都等价于"没有意见"，绝不能让分类器故障
 * 导致危险命令被自动放行——这是 memory.ts captureFromTurn 同款的"软功能，失败静默降级"模式。
 */
/**
 * `reason` 只在分类器真正跑完一次判断时才会有值（无论 safe 与否）；调用失败/超时/模型
 * 不可用时 `reason` 为 undefined，调用方据此区分"分类器说不安全"和"分类器根本没跑起来"。
 */
export async function classifyShellCommand(
  command: string,
  models: ModelResolver,
  signal?: AbortSignal,
): Promise<{ safe: boolean; reason?: string }> {
  try {
    const resolved = await models.resolve("orchestrator");
    if (resolved.length === 0) return { safe: false };
    const result = await completeStructured({
      models: resolved,
      schema: Verdict,
      maxTokens: 150,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      systemPrompt:
        "判断这条 shell 命令是否是常见安全操作的变体（只读查看、版本查询、构建/测试等无副作用操作）。" +
        "不确定就返回 safe:false。只看命令本身，不要臆测用户意图。reason 用一句中文，不超过 40 字。",
      prompt: command,
    });
    return { safe: result.safe, reason: result.reason };
  } catch {
    return { safe: false };
  }
}
