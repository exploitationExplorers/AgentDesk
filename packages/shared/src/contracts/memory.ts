import { z } from "zod";

export const MemoryKind = z.enum(["preference", "fact", "decision"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MemorySource = z.enum(["tool", "auto"]);
export type MemorySource = z.infer<typeof MemorySource>;

export const MemoryStatus = z.enum(["candidate", "active", "superseded"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MemoryPolicy = z.object({
  enabled: z.boolean().default(true),
  autoCaptureEnabled: z.boolean().default(true),
  /** 开启时，自动提取会把用户文本发送给当前配置的模型。 */
  allowCloudExtraction: z.boolean().default(true),
});
export type MemoryPolicy = z.infer<typeof MemoryPolicy>;

/** 补丁不带默认值，避免只改一个开关时重置其他隐私选择。 */
export const MemoryPolicyPatch = z
  .object({
    enabled: z.boolean().optional(),
    autoCaptureEnabled: z.boolean().optional(),
    allowCloudExtraction: z.boolean().optional(),
  })
  .strict();
export type MemoryPolicyPatch = z.infer<typeof MemoryPolicyPatch>;

export const MemoryCorrection = z.object({
  text: z.string().trim().min(2).max(500),
  expiresAt: z.iso.datetime().nullable().optional(),
});
export type MemoryCorrection = z.infer<typeof MemoryCorrection>;

/** 设置页直接确认的用户记忆，不接受客户端指定来源或项目命名空间。 */
export const MemoryCreate = z
  .object({
    text: z.string().trim().min(2).max(500),
    kind: MemoryKind,
  })
  .strict();
export type MemoryCreate = z.infer<typeof MemoryCreate>;

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
  scope: z.enum(["user", "project"]).default("user"),
  status: MemoryStatus.default("active"),
  /** 项目工作区的不可逆标识，不包含本地绝对路径。 */
  workspace: z.string().nullable().default(null),
  evidence: z.string().nullable().default(null),
  supersedesId: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
});
export type Memory = z.infer<typeof Memory>;

export const MemoryList = z.array(Memory);
export type MemoryList = z.infer<typeof MemoryList>;

export const MemoryDeleted = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type MemoryDeleted = z.infer<typeof MemoryDeleted>;
