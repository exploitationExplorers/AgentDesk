/*!
 * Exa 文本协议解析与错误分类参考 Agent-Reach 1.6.1：
 * https://github.com/Panniantong/Agent-Reach/tree/7a38047acf26a729cbb27851e3cb81639da86b29
 *
 * MIT License
 * Copyright (c) 2025 Agent Eyes
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { ReachChannelError, makeItem, type ReachChannelDef, type ReachContext } from "../types";
import type { ReachItem } from "@agentdesk/shared";
import { checkReachResponse } from "../http";

const EXA_MCP = "https://mcp.exa.ai/mcp";
const JINA = "https://r.jina.ai/";

/** Exa 的限流/额度用尽信号，命中后按 RATE_LIMITED 处理而不是换后端硬打。 */
const LIMIT_RE =
  /\b429\b|rate[ _-]?limit|too many requests|\bquota\b|(?:usage|request|daily|monthly|free)[ _-]+limit|(?:credit|credits|balance).{0,40}(?:exhaust|deplet|insufficient|exceed|reach)|(?:out of|insufficient|exhausted).{0,20}credits?/i;

function exaError(text: string, rpcCode?: number | string): ReachChannelError {
  const snippet = text.slice(0, 300);
  if (rpcCode === -32602 || rpcCode === "-32602")
    return new ReachChannelError("BAD_INPUT", `Exa 拒绝了参数：${snippet}`);
  if (rpcCode === 429 || rpcCode === "429" || LIMIT_RE.test(text))
    return new ReachChannelError(
      "RATE_LIMITED",
      `Exa 额度或频率受限：${snippet}`,
      "Exa 托管搜索有免费额度上限，过一会儿再试，或改用 reach.read 直接读已知链接",
    );
  return new ReachChannelError("UPSTREAM_BROKEN", `Exa：${snippet}`);
}

/**
 * 调用 Exa 免费托管 MCP 的一个工具。
 * 响应可能是 SSE 形式（多行 `data:`），取最后一条；也可能是单个 JSON。
 */
async function exaCall(
  tool: string,
  args: Record<string, unknown>,
  ctx: ReachContext,
): Promise<string> {
  const response = await ctx.fetch(EXA_MCP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    timeoutMs: Math.max(1000, ctx.deadline - Date.now()),
  });
  checkReachResponse(response, "Exa");

  let message: {
    error?: { message?: string; code?: number };
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  };
  try {
    const payloads =
      response.contentType.includes("text/event-stream") || response.text.includes("data:")
        ? response.text.split(/\r?\n\r?\n/).map((event) =>
            event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n"),
          )
        : [response.text];
    const messages = payloads
      .filter((value) => value.trim() && value.trim() !== "[DONE]")
      .map((value) => JSON.parse(value) as Record<string, unknown> | null);
    const found = messages.find(
      (value) => value?.id === 1 && ("result" in value || "error" in value),
    );
    if (!found) throw new Error("Missing tool response");
    message = found;
  } catch {
    throw new ReachChannelError("UPSTREAM_BROKEN", "Exa 返回的不是合法 JSON");
  }
  if (message.error) throw exaError(String(message.error.message ?? ""), message.error.code);
  if (!Array.isArray(message.result?.content))
    throw new ReachChannelError("UPSTREAM_BROKEN", "Exa 工具响应缺少内容");

  const text = (message.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (message.result?.isError) throw exaError(text);
  return text;
}

/** Exa 返回的是 `Title: / URL: / Published: / Author:` 文本块，切成条目。 */
function parseExa(text: string): ReachItem[] {
  const items: ReachItem[] = [];
  for (const block of `\n${text.trim()}`.split(/\n(?=Title: )/)) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("Title:")) continue;
    const lines = trimmed.split("\n");
    const fields: Record<string, string> = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const m = /^(Title|URL|Published|Author):\s*(.*)$/.exec(lines[i]!);
      if (!m) break;
      fields[m[1]!.toLowerCase()] = m[2]!.trim();
    }
    const body = lines
      .slice(i)
      .filter((l) => !["Highlights:", "Text:"].includes(l.trim()))
      .join("\n")
      .trim();
    const clean = (v?: string) => (!v || v === "N/A" ? null : v);
    if (!clean(fields.url)) continue;
    items.push(
      makeItem({
        title: clean(fields.title) ?? "(无标题)",
        url: fields.url!,
        author: clean(fields.author),
        publishedAt: clean(fields.published),
        text: body,
        // 搜索返回的是摘要片段，不是完整正文。
        partial: true,
      }),
    );
  }
  return items;
}

function isAntibot(text: string): boolean {
  const s = text.slice(0, 4000).toLowerCase();
  const jinaCaptcha = s.includes("warning:") && s.includes("requiring captcha");
  const challenge =
    s.includes("title: just a moment...") ||
    s.includes("## performing security verification") ||
    s.includes("title: attention required! | cloudflare");
  return (
    (jinaCaptcha && challenge) ||
    (s.includes("attention required! | cloudflare") &&
      (s.includes("ray id") || s.includes("/cdn-cgi/challenge-platform/")))
  );
}

export const webChannel: ReachChannelDef = {
  id: "web",
  title: "全网",
  description: "全网搜索与网页正文读取",
  sendsDataTo: ["mcp.exa.ai", "r.jina.ai"],
  requires: [],
  actions: [
    {
      name: "search",
      description: "按关键词搜索全网，返回标题、链接与摘要",
      backends: [
        {
          id: "exa",
          run: async ({ query, limit }, ctx) => {
            if (!query?.trim()) throw new ReachChannelError("BAD_INPUT", "search 需要 query");
            const text = await exaCall(
              "web_search_exa",
              { query, objective: query, numResults: limit },
              ctx,
            );
            const items = parseExa(text);
            // 认不出来的响应不能当成「搜到 0 条」——那会让模型以为这个话题没人讨论。
            if (items.length === 0)
              throw new ReachChannelError("UPSTREAM_BROKEN", "Exa 返回了无法识别的搜索结果");
            return items.slice(0, limit);
          },
        },
      ],
    },
    {
      name: "read",
      description: "读取网页正文",
      backends: [
        {
          // 先用本地抓取：不把用户想读的网址告诉任何第三方。
          id: "local",
          run: async ({ target }, ctx) => {
            if (!target) throw new ReachChannelError("BAD_INPUT", "read 需要 target");
            const text = await ctx.readArticle(target);
            return [makeItem({ title: target, url: target, text, partial: false })];
          },
        },
        {
          // 本地抽取不出正文（前端渲染页等）时才走 Jina。
          id: "jina",
          run: async ({ target }, ctx) => {
            if (!target) throw new ReachChannelError("BAD_INPUT", "read 需要 target");
            await ctx.validateUrl(target);
            const response = await ctx.fetch(`${JINA}${target}`, {
              headers: { Accept: "text/plain" },
              timeoutMs: Math.max(1000, ctx.deadline - Date.now()),
            });
            checkReachResponse(response, "Jina");
            if (isAntibot(response.text))
              throw new ReachChannelError(
                "PLATFORM_BLOCKED",
                "Jina Reader 返回了反爬验证页，没拿到目标内容",
                "这个站点需要浏览器访问，可以用 browser.open 手动打开",
              );
            if (!response.text.trim())
              throw new ReachChannelError("UPSTREAM_BROKEN", "Jina 未返回正文");
            return [makeItem({ title: target, url: target, text: response.text, partial: false })];
          },
        },
      ],
    },
  ],
};
