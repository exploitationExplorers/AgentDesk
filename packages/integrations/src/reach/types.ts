import type { ReachActionName, ReachErrorCode, ReachItem } from "@agentdesk/shared";

/**
 * 渠道实现抛出的错误。`code` 决定调度器是换后端、重试还是直接停下来。
 */
export class ReachChannelError extends Error {
  constructor(
    readonly code: ReachErrorCode,
    message: string,
    /** 给用户看的下一步操作，例如「去设置页填 Token」。 */
    readonly nextStep?: string,
    readonly retryAfterSeconds?: number,
    readonly items: ReachItem[] = [],
  ) {
    super(message);
    this.name = "ReachChannelError";
  }
}

export interface ReachFetchInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 响应体字节上限，超出按 UPSTREAM_BROKEN 处理。 */
  maxBytes?: number;
}

export interface ReachFetchResponse {
  status: number;
  contentType: string;
  text: string;
  headers?: Record<string, string>;
}

/**
 * 渠道运行时上下文。网络能力由宿主注入——渠道实现本身不直接碰 fetch，
 * 这样 SSRF 校验、重定向 DNS 固定、体积上限只需要在 sidecar 里实现一次。
 */
export interface ReachContext {
  signal?: AbortSignal;
  /** 已做公开地址校验的 HTTP 请求。 */
  fetch: (url: string, init?: ReachFetchInit) => Promise<ReachFetchResponse>;
  /** 读取公开网页正文并抽取为纯文本，完全走本地，不经第三方。 */
  readArticle: (url: string) => Promise<string>;
  /** 在把目标网址交给正文服务前也必须校验，不能只检查中转服务的地址。 */
  validateUrl: (url: string) => Promise<void>;
  /** 本次实际发出的请求主机，由宿主记录。 */
  sentTo: Set<string>;
  /** 按名字取凭据；没有配置时返回 undefined，渠道据此决定降级还是报 NEED_SETUP。 */
  secret: (name: string) => Promise<string | undefined>;
  /** 本次动作的截止时刻（epoch ms）。 */
  deadline: number;
}

export interface ReachParams {
  /** search 用。 */
  query?: string;
  /** read / node / user 用：URL、节点名或用户名。 */
  target?: string;
  limit: number;
}

export interface ReachBackend {
  /** 出现在结果的 `backend` 字段里。`public-web` 约定表示公开网页降级结果。 */
  id: string;
  run: (params: ReachParams, ctx: ReachContext) => Promise<ReachItem[]>;
}

export interface ReachActionDef {
  name: ReachActionName;
  description: string;
  /** 按顺序尝试，前一个失败且错误可恢复时才换下一个。 */
  backends: ReachBackend[];
}

export interface ReachChannelDef {
  id: string;
  title: string;
  description: string;
  /** 会把数据发给哪些第三方服务，用于界面明示；本地完成则为空。 */
  sendsDataTo: string[];
  /** 需要哪些额外配置才能完整工作；开箱可用则为空。 */
  requires: string[];
  actions: ReachActionDef[];
}

/** 构造一条结果项，省去每个渠道重复写可空字段。 */
export function makeItem(input: {
  title: string;
  url: string;
  text: string;
  partial: boolean;
  author?: string | null;
  publishedAt?: string | null;
  extra?: Record<string, string | number | boolean>;
}): ReachItem {
  return {
    title: input.title || "(无标题)",
    url: input.url,
    author: input.author ?? null,
    publishedAt: input.publishedAt ?? null,
    text: input.text,
    partial: input.partial,
    ...(input.extra ? { extra: input.extra } : {}),
  };
}
