import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, Headers, ProxyAgent, fetch } from "undici";
import { AppError, ErrorCode } from "@agentdesk/shared";
import { currentProxy } from "../proxy";

const blocked = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, bits, "ipv4");

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  // 仅接受全球单播 IPv6，排除本地、映射 IPv4、文档和隧道地址。
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^(2001:|2002:)/i.test(address);
}

export function publicSourceUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError(ErrorCode.BadRequest, "请输入有效的公开 HTTP/HTTPS 链接");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  ) {
    throw new AppError(ErrorCode.BadRequest, "只支持不含凭据的公开 HTTP/HTTPS 文章链接");
  }
  return url;
}

/** DNS 查询也受取消和预算限制，避免请求开始前无限等待。 */
export async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function resolvePublicSource(input: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = publicSourceUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await withAbort(lookup(hostname, { all: true }), signal);
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new AppError(ErrorCode.BadRequest, "资料链接必须指向公网地址");
  }
  return { url, addresses };
}

export interface PublicFetchOptions {
  signal?: AbortSignal;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  cookieJar?: {
    get(url: URL): string;
    set(url: URL, cookies: string[]): void;
  };
  onRequest?: (url: URL) => void;
}

/** 重定向逐次校验并固定 DNS，响应按流限长；跨来源重定向不携带凭据。 */
export async function fetchPublicSource(input: string, options: PublicFetchOptions = {}) {
  let url = publicSourceUrl(input);
  let method = options.method ?? "GET";
  let body = options.body;
  // 使用常见桌面 Chrome UA：不少站点（含文档 CDN）会拦截自定义爬虫标识。
  const headers = new Headers({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    ...options.headers,
  });
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 25_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const maxRedirects = Math.min(10, Math.max(0, options.maxRedirects ?? 3));
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    // 先本地解析并拒绝内网地址；真正出站时若配置了代理则走代理（GitHub raw 等在国内常需代理）。
    const { addresses } = await resolvePublicSource(url.href, signal);
    const first = addresses[0]!;
    const proxy = currentProxy();
    const dispatcher = proxy
      ? new ProxyAgent(proxy)
      : new Agent({
          connect: {
            lookup: (_hostname, opts, callback) => {
              if (opts.all) callback(null, addresses);
              else callback(null, first.address, first.family);
            },
          },
        });
    try {
      signal.throwIfAborted();
      options.onRequest?.(url);
      if (options.cookieJar) {
        const cookie = options.cookieJar.get(url);
        if (cookie) headers.set("cookie", cookie);
        else headers.delete("cookie");
      }
      const response = await fetch(url, {
        dispatcher,
        redirect: "manual",
        signal,
        method,
        body,
        headers,
      });
      options.cookieJar?.set(url, response.headers.getSetCookie());
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === maxRedirects) throw new Error("重定向过多或缺少目标地址");
        const next = publicSourceUrl(new URL(location, url).href);
        if (url.protocol === "https:" && next.protocol !== "https:") {
          throw new AppError(ErrorCode.BadRequest, "拒绝降级到 HTTP 的重定向");
        }
        if (next.origin !== url.origin) {
          for (const name of ["authorization", "cookie", "proxy-authorization"])
            headers.delete(name);
          if (method === "POST") throw new AppError(ErrorCode.BadRequest, "拒绝跨来源转发请求正文");
        }
        if (
          response.status === 303 ||
          (method === "POST" && [301, 302].includes(response.status))
        ) {
          method = "GET";
          body = undefined;
          headers.delete("content-type");
        }
        url = next;
        continue;
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        while (reader) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > (options.maxBytes ?? 4 * 1024 ** 2)) throw new Error("响应正文超过大小限制");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader?.cancel();
      }
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        headers: Object.fromEntries(response.headers.entries()),
        text,
      };
    } finally {
      // 销毁本次专用连接，取消时不等待闲置 socket 的 keep-alive 超时。
      await dispatcher.destroy();
    }
  }
  throw new Error("重定向过多");
}
