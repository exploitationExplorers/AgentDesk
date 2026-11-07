import type { Message } from "@mariozechner/pi-ai";

/** 未掌握供应商的图像分块规则时，每张图预留保守预算；base64 只是传输编码。 */
export const ESTIMATED_IMAGE_TOKENS = 8192;

/** 无 tokenizer 的跨供应商估算；界面必须明确标注为估算，不能作为计费用量。 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let unicode = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else unicode += character.length;
  }
  return Math.ceil(ascii / 3) + unicode;
}

export function estimateMessageTokens(messages: Message[]): number {
  return messages.reduce((total, message) => {
    const envelope =
      message.role === "toolResult"
        ? `${message.role} ${message.toolName} ${message.toolCallId}`
        : message.role;
    const contentTokens =
      typeof message.content === "string"
        ? estimateTokens(message.content)
        : message.content.reduce((tokens, block) => {
            if (block.type === "image") return tokens + ESTIMATED_IMAGE_TOKENS;
            if (block.type === "text") return tokens + estimateTokens(block.text) + 8;
            if (block.type === "thinking") return tokens + estimateTokens(block.thinking) + 8;
            return tokens + estimateTokens(JSON.stringify(block)) + 8;
          }, 0);
    return total + estimateTokens(envelope) + contentTokens + 8;
  }, 0);
}

/** 为输出与分词误差留出空间。实际请求前还会计入工具定义和完整系统提示。 */
export function inputBudget(contextWindow: number, maxOutputTokens: number): number {
  return Math.max(0, Math.floor(contextWindow * 0.9) - maxOutputTokens);
}

export class ModelContextBudgetError extends Error {
  constructor(estimatedTokens: number, contextWindow: number) {
    super(
      `模型上下文超出输入预算（估算 ${estimatedTokens} tokens，窗口 ${contextWindow}）。已保留执行记录，请缩小检查范围或配置更大的模型窗口后继续。`,
    );
    this.name = "ModelContextBudgetError";
  }
}

/** 仅缩短发给模型的工具正文；调用 ID、用户决定和持久化原始结果均保持完整。 */
export function fitToolResults(
  messages: Message[],
  budget: number,
  preservedTools: ReadonlySet<string>,
): Message[] {
  let size = estimateMessageTokens(messages);
  if (size <= budget) return messages;
  const fitted = [...messages];
  const target = Math.max(0, Math.floor(budget * 0.8));
  // 先处理旧输出，优先保留最近读到的证据；极长的单次结果也不能击穿输入窗口。
  for (const limit of [3000, 600]) {
    for (let index = 0; index < fitted.length && size > target; index++) {
      const message = fitted[index]!;
      if (message.role !== "toolResult" || preservedTools.has(message.toolName)) continue;
      const content = message.content.map((block) => {
        if (block.type !== "text" || block.text.length <= limit) return block;
        const head = Math.floor(limit * 0.75);
        return {
          ...block,
          text: `${block.text.slice(0, head)}\n[工具输出已截取；中间内容未包含在本次输入中，完整结果保留在执行记录。需要核实时请重新查询原始资料，不要推断省略内容。]\n${block.text.slice(-(limit - head))}`,
        };
      });
      const shortened = { ...message, content };
      size += estimateMessageTokens([shortened]) - estimateMessageTokens([message]);
      fitted[index] = shortened;
    }
  }
  return fitted;
}
