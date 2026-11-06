import { AutoloopInteractionAnswer } from "@agentdesk/shared";
import { z } from "zod";

const prefix = "agentdesk:automation:pending:";
const PendingEvent = z.object({
  eventId: z.string().min(1).max(180),
  message: z.string().optional(),
});
export type PendingEvent = z.infer<typeof PendingEvent>;

function read<T>(key: string, schema: z.ZodType<T>): T | null {
  try {
    const value = localStorage.getItem(prefix + key);
    if (!value) return null;
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(prefix + key, JSON.stringify(value));
  } catch {
    throw new Error("无法保存待提交记录，请允许本地存储后重试。");
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(prefix + key);
  } catch {
    // 已确认的请求即使未能清理，下次仍使用相同 ID 安全重试。
  }
}

export const readPendingEvent = (scope: string) => read(scope, PendingEvent);

export function preparePendingEvent(scope: string, message?: string): PendingEvent {
  const saved = readPendingEvent(scope);
  if (saved) {
    if (saved.message !== message) throw new Error("上次提交尚未确认，请先重试原请求。");
    return saved;
  }
  const pending = { eventId: crypto.randomUUID(), ...(message === undefined ? {} : { message }) };
  write(scope, pending);
  return pending;
}

export function clearPendingEvent(scope: string, eventId: string): void {
  if (readPendingEvent(scope)?.eventId === eventId) remove(scope);
}

export const readPendingAnswer = (cardId: string) =>
  read(`answer:${cardId}`, AutoloopInteractionAnswer);

export function savePendingAnswer(cardId: string, answer: AutoloopInteractionAnswer): void {
  write(`answer:${cardId}`, answer);
}

export function clearPendingAnswer(cardId: string, answerId: string): void {
  if (readPendingAnswer(cardId)?.answerId === answerId) remove(`answer:${cardId}`);
}
