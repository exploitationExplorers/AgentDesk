import { z } from "zod";

export const MemoryKind = z.enum(["preference", "fact", "decision"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemorySource = z.enum(["tool", "auto"]);
export type MemorySource = z.infer<typeof MemorySource>;

/** 跨会话保留的一条偏好、事实或决定。 */
export const Memory = z.object({
  id: z.string(),
  namespace: z.string(),
  kind: MemoryKind,
  text: z.string(),
  source: MemorySource,
  conversationId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Memory = z.infer<typeof Memory>;

export const MemoryList = z.array(Memory);
export type MemoryList = z.infer<typeof MemoryList>;

export const MemoryDeleted = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type MemoryDeleted = z.infer<typeof MemoryDeleted>;
