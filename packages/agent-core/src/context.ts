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
