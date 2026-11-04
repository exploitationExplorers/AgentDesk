import { parse } from "node-html-parser";
import { fetchPublicSource } from "./public-fetch";
export { isPublicAddress, publicSourceUrl } from "./public-fetch";

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
      document.querySelector("body");
    return (article?.structuredText ?? "").trim();
  }
  return text.trim();
}

export async function readPublicArticle(input: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchPublicSource(input, {
    signal,
    headers: { Accept: "text/html,text/plain" },
  });
  if (response.status >= 400) throw new Error(`文章读取失败（HTTP ${response.status}）`);
  if (!/text\/(html|plain)|application\/xhtml/i.test(response.contentType)) {
    throw new Error("链接未返回网页正文，请粘贴资料文本");
  }
  const text = articleText(response.text, response.contentType);
  if (
    text.length < 100 ||
    /环境异常|完成验证后即可继续访问|访问过于频繁/.test(text.slice(0, 500))
  ) {
    throw new Error("网站需要验证或没有可读取正文，请粘贴文章正文后分析");
  }
  return text.slice(0, 60_000);
}
