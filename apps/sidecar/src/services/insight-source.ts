import { parse } from "node-html-parser";
import { articleMirrorCandidates, prefersArticleMirror } from "./article-mirrors";
import { fetchPublicSource } from "./public-fetch";
export { isPublicAddress, publicSourceUrl } from "./public-fetch";

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7";

const CHALLENGE_RE =
  /环境异常|完成验证后即可继续访问|访问过于频繁|just a moment|attention required!|requiring captcha|vercel security checkpoint/i;

function stripFrontMatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

export function articleText(text: string, contentType: string): string {
  if (contentType.toLowerCase().includes("html")) {
    const document = parse(text);
    document
      .querySelectorAll("script,style,nav,footer,svg,noscript")
      .forEach((element) => element.remove());
    const article =
      document.querySelector("#js_content") ??
      document.querySelector("article") ??
      document.querySelector("main") ??
      document.querySelector(".md-content") ??
      document.querySelector("body");
    return (article?.structuredText ?? "").trim();
  }
  return stripFrontMatter(text);
}

function isChallengeResponse(status: number, headers: Record<string, string>, text: string) {
  if (status === 429 || status === 403) return true;
  if (/challenge/i.test(headers["x-vercel-mitigated"] ?? "")) return true;
  return CHALLENGE_RE.test(text.slice(0, 1000));
}

async function fetchArticleCandidate(url: string, signal?: AbortSignal) {
  const response = await fetchPublicSource(url, {
    signal,
    headers: {
      Accept: BROWSER_ACCEPT,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  return response;
}

/**
 * 读取公开文章正文。
 * 对带 CDN 人机校验的开源文档站，会改走 GitHub raw 等公开镜像。
 */
export async function readPublicArticle(input: string, signal?: AbortSignal): Promise<string> {
  const mirrors = articleMirrorCandidates(input);
  // 已知有公开镜像的站点不要回落到源站：源站 CDN 校验的 429 会盖住镜像的真实错误。
  const queue = prefersArticleMirror(input) ? mirrors : [input, ...mirrors];
  const candidates = [...new Set(queue.length ? queue : [input])];

  let lastError: Error | undefined;
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      const response = await fetchArticleCandidate(candidate, signal);
      if (isChallengeResponse(response.status, response.headers, response.text)) {
        lastError = new Error(`文章读取失败（HTTP ${response.status}）`);
        continue;
      }
      if (response.status >= 400) {
        lastError = new Error(`文章读取失败（HTTP ${response.status}）`);
        continue;
      }
      if (
        !/text\/(html|plain|markdown)|application\/xhtml/i.test(response.contentType) &&
        !candidate.endsWith(".md")
      ) {
        lastError = new Error("链接未返回网页正文，请粘贴资料文本");
        continue;
      }
      const text = articleText(response.text, response.contentType || "text/plain");
      if (text.length < 100 || CHALLENGE_RE.test(text.slice(0, 500))) {
        lastError = new Error("网站需要验证或没有可读取正文，请粘贴文章正文后分析");
        continue;
      }
      return text.slice(0, 60_000);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("文章读取失败，请粘贴正文后重试");
}
