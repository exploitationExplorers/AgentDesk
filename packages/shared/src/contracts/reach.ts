import { z } from "zod";

/**
 * 跨平台内容读取层的共享契约。
 *
 * 协议形状参考 Agent-Reach 1.6.1（MIT），但本项目是原生 TypeScript 实现，
 * 不依赖其 Python 运行时。保留它的错误语义是因为那套分类确实区分清楚了
 * 「能重试」「该换后端」和「必须停下来找用户」三类失败。
 */
export const REACH_SCHEMA_VERSION = 1;

/**
 * 失败分类。其中 NEED_LOGIN / PLATFORM_BLOCKED / RATE_LIMITED / BAD_INPUT /
 * NOT_FOUND 属于终止态：不切后端、不重试，直接把情况告诉用户。
 */
export const ReachErrorCode = z.enum([
  /** 缺少依赖或配置，需要用户去设置页处理。 */
  "NEED_SETUP",
  /** 需要登录才能继续，已有的公开结果仍然保留。 */
  "NEED_LOGIN",
  /** 上游服务本身坏了，可有限重试。 */
  "UPSTREAM_BROKEN",
  /** 超出本次动作预算。 */
  "TIMEOUT",
  /** 被限流，必须尊重冷却时间。 */
  "RATE_LIMITED",
  /** 平台主动阻断，停止自动访问。 */
  "PLATFORM_BLOCKED",
  /** 目标不存在。 */
  "NOT_FOUND",
  /** 输入参数不合法。 */
  "BAD_INPUT",
  /** 资源忙（并发槽位已满），稍后再试，不要另起一路。 */
  "BUSY",
]);
export type ReachErrorCode = z.infer<typeof ReachErrorCode>;

/** 这些错误不应该触发换后端或自动重试。 */
export const TERMINAL_REACH_ERRORS: ReachErrorCode[] = [
  "NEED_LOGIN",
  "PLATFORM_BLOCKED",
  "RATE_LIMITED",
  "BAD_INPUT",
  "NOT_FOUND",
];

export const ReachActionName = z.enum(["search", "read", "hot", "node", "user"]);
export type ReachActionName = z.infer<typeof ReachActionName>;

/** 一条检索结果。`text` 是正文或摘要，由 `partial` 区分。 */
export const ReachItem = z.object({
  title: z.string(),
  url: z.string(),
  author: z.string().nullable(),
  publishedAt: z.string().nullable(),
  text: z.string(),
  /** true 表示这只是摘要片段，不是完整正文——模型不能当全文引用。 */
  partial: z.boolean(),
  /** 平台特有的少量字段，已做裁剪，不放原始大对象。 */
  extra: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type ReachItem = z.infer<typeof ReachItem>;

export const ReachAttempt = z.object({
  backend: z.string(),
  ok: z.boolean(),
  code: ReachErrorCode.nullable(),
  elapsedMs: z.number().int(),
});
export type ReachAttempt = z.infer<typeof ReachAttempt>;

/** 统一结果信封。失败时 ok=false 且 error 非空，items 可能仍有部分内容。 */
export const ReachResult = z.object({
  schemaVersion: z.literal(REACH_SCHEMA_VERSION),
  ok: z.boolean(),
  channel: z.string(),
  action: ReachActionName,
  /** 实际产出结果的后端。public-web 表示这是公开网页降级结果。 */
  backend: z.string().nullable(),
  items: z.array(ReachItem),
  meta: z.object({
    elapsedMs: z.number().int(),
    /** 采集时间，供模型准确引用。 */
    fetchedAt: z.string(),
    attempts: z.array(ReachAttempt),
    /** 结果或正文是否因长度上限被截断。 */
    truncated: z.boolean(),
    /** 数据外发对象，例如 ["exa.ai"]；没有外发则为空数组。 */
    sentTo: z.array(z.string()),
  }),
  error: z
    .object({
      code: ReachErrorCode,
      message: z.string(),
      /** 用户可执行的下一步，没有则为 null。 */
      nextStep: z.string().nullable(),
      retryAfterSeconds: z.number().nonnegative().optional(),
    })
    .nullable(),
});
export type ReachResult = z.infer<typeof ReachResult>;

/** 渠道能力声明。模型通过 reach.capabilities 拿到的就是这个。 */
export const ReachChannelInfo = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  actions: z.array(ReachActionName),
  enabled: z.boolean(),
  /** 该渠道会把数据发给哪些第三方服务，用于界面明示。 */
  sendsDataTo: z.array(z.string()),
  /** 是否需要额外配置才能用；为空表示开箱可用。 */
  requires: z.array(z.string()),
});
export type ReachChannelInfo = z.infer<typeof ReachChannelInfo>;

export const ReachCapabilities = z.object({
  schemaVersion: z.literal(REACH_SCHEMA_VERSION),
  channels: z.array(ReachChannelInfo),
});
export type ReachCapabilities = z.infer<typeof ReachCapabilities>;

/** 单个渠道的健康状态。lastCheckedAt 为空表示从未实测过。 */
export const ReachChannelStatus = z.object({
  id: z.string(),
  enabled: z.boolean(),
  ok: z.boolean().nullable(),
  lastCheckedAt: z.string().nullable(),
  detail: z.string().nullable(),
});
export type ReachChannelStatus = z.infer<typeof ReachChannelStatus>;

export const ReachStatus = z.object({
  channels: z.array(ReachChannelStatus),
});
export type ReachStatus = z.infer<typeof ReachStatus>;

export const ReachSettings = z.object({
  /** 被显式关闭的渠道 id。 */
  disabledChannels: z.array(z.string().min(1).max(80)).max(100),
});
export type ReachSettings = z.infer<typeof ReachSettings>;

export const ReachRequest = z
  .object({
    channel: z.string().trim().min(1).max(80),
    action: ReachActionName,
    query: z.string().trim().min(1).max(2000).optional(),
    target: z.string().trim().min(1).max(4096).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .superRefine((value, ctx) => {
    const field = value.action === "search" ? "query" : value.action === "hot" ? null : "target";
    if (field && !value[field])
      ctx.addIssue({ code: "custom", path: [field], message: `${field} is required` });
  });
export type ReachRequest = z.infer<typeof ReachRequest>;
export type ReachRequestInput = z.input<typeof ReachRequest>;
