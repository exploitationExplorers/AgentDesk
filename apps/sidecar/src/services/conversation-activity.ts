import { AppError, ErrorCode } from "@agentdesk/shared";

/** 同一会话的执行和压缩共用互斥边界，避免摘要覆盖新写入的历史。 */
const active = new Map<string, "running" | "compacting">();

export function conversationActivity(id: string): "running" | "compacting" | null {
  return active.get(id) ?? null;
}

export function acquireConversation(id: string, activity: "running" | "compacting"): () => void {
  if (active.has(id)) throw new AppError(ErrorCode.Conflict, "会话正在执行或压缩，请稍后再试");
  active.set(id, activity);
  return () => active.delete(id);
}
