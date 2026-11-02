import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch } from "undici";
import { parse } from "node-html-parser";
import { AppError, ErrorCode } from "@agentdesk/shared";

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
] as const) {
  blocked.addSubnet(network, bits, "ipv4");
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  // 仅接受全球单播 IPv6，排除本地、映射 IPv4、文档和隧道地址。
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^(2001:|2002:)/i.test(address);
}

export function publicSourceUrl(input: string): URL {
  const url = new URL(input);
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

/** 重定向逐次校验并固定 DNS 解析地址，不允许文章读取访问本机或内网。 */
export async function readPublicArticle(input: string, signal?: AbortSignal): Promise<string> {
  let url = publicSourceUrl(input);
  const timeout = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new AppError(ErrorCode.BadRequest, "资料链接必须指向公网地址");
    }
    const first = addresses[0]!;
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, first.address, first.family);
        },
      },
    });
    try {
      const response = await fetch(url, {
        dispatcher,
        redirect: "manual",
        signal: timeout,
        headers: { "User-Agent": "Mozilla/5.0 AgentDesk/1.0", Accept: "text/html,text/plain" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) break;
        url = publicSourceUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body)
        throw new Error(`文章读取失败（HTTP ${response.status}）`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!/text\/(html|plain)|application\/xhtml/i.test(contentType)) {
        await response.body.cancel();
        throw new Error("链接未返回网页正文，请粘贴资料文本");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4 * 1024 ** 2) throw new Error("文章过大，请粘贴需要分析的正文");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      if (contentType.includes("html")) {
        const document = parse(text);
        document.querySelectorAll("script,style,nav,footer").forEach((element) => element.remove());
        const article =
          document.querySelector("#js_content") ??
          document.querySelector("article") ??
          document.querySelector("main") ??
          document.querySelector("body");
        text = article?.structuredText ?? "";
      }
      text = text.trim();
      if (
        text.length < 100 ||
        /环境异常|完成验证后即可继续访问|访问过于频繁/.test(text.slice(0, 500))
      ) {
        throw new Error("网站需要验证或没有可读取正文，请粘贴文章正文后分析");
      }
      return text.slice(0, 60_000);
    } finally {
      await dispatcher.close();
    }
  }
  throw new AppError(ErrorCode.IntegrationFailed, "文章重定向过多，请粘贴正文后分析");
}
