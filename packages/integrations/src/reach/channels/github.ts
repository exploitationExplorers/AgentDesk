import { ReachChannelError, makeItem, type ReachChannelDef, type ReachContext } from "../types";
import type { ReachItem } from "@agentdesk/shared";
import { checkReachResponse } from "../http";

const API = "https://api.github.com";

/**
 * github.token 由宿主映射到已有 Git 平台账号，不单独存储一套凭据。
 *
 * 刻意不去读本机 `gh` CLI 的登录态：那会让检索在用户不知情的情况下用上
 * 另一个 GitHub 账号。没有配置 Token 时就走匿名公开 API（有较低的速率上限）。
 */
async function ghFetch<T>(path: string, ctx: ReachContext, accept?: string): Promise<T> {
  const token = await ctx.secret("github.token");
  const response = await ctx.fetch(`${API}${path}`, {
    headers: {
      Accept: accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    timeoutMs: Math.max(1000, ctx.deadline - Date.now()),
  });
  if (response.status === 404) throw new ReachChannelError("NOT_FOUND", "GitHub 返回 404");
  if (response.status === 401)
    throw new ReachChannelError("NEED_SETUP", "GitHub Token 无效", "去设置页更新 GitHub Token");
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers?.["x-ratelimit-remaining"] === "0" || /rate.?limit/i.test(response.text)))
  ) {
    const anonymous = !token;
    throw new ReachChannelError(
      "RATE_LIMITED",
      `GitHub 限流（HTTP ${response.status}）`,
      anonymous ? "匿名访问速率很低，去设置页配一个 GitHub Token 可以大幅提高" : "等待速率窗口重置",
      Math.max(
        1,
        Number(response.headers?.["retry-after"]) ||
          Number(response.headers?.["x-ratelimit-reset"]) - Math.floor(Date.now() / 1000) ||
          60,
      ),
    );
  }
  checkReachResponse(response, "GitHub");
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new ReachChannelError("UPSTREAM_BROKEN", "GitHub 返回的不是合法 JSON");
  }
}

/** 解析 owner/repo、完整仓库链接，以及 issue / PR 链接。 */
function parseTarget(target: string): { owner: string; repo: string; number?: number } {
  let t = target.trim();
  if (/^https?:\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      throw new ReachChannelError("BAD_INPUT", "GitHub 链接无效");
    }
    if (
      !["github.com", "www.github.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    ) {
      throw new ReachChannelError("BAD_INPUT", "仅支持公开 github.com 链接");
    }
    t = url.pathname.slice(1);
  }
  t = t.replace(/\/$/, "");
  const m = /^([a-zA-Z0-9][\w.-]*)\/([a-zA-Z0-9_.-]+)(?:\/(?:issues|pull)\/([1-9]\d*))?$/.exec(t);
  if (!m || [".", ".."].includes(m[2]!))
    throw new ReachChannelError(
      "BAD_INPUT",
      "target 需要是 owner/repo 或 GitHub 仓库 / Issue / PR 链接",
    );
  return { owner: m[1]!, repo: m[2]!, number: m[3] ? Number(m[3]) : undefined };
}

export const githubChannel: ReachChannelDef = {
  id: "github",
  title: "GitHub",
  description: "搜索仓库、读取仓库介绍与 Issue / PR 讨论",
  sendsDataTo: ["api.github.com"],
  requires: ["可选：GitHub Token（不配也能用，但匿名速率很低）"],
  actions: [
    {
      name: "search",
      description: "搜索仓库（不是通用代码搜索）",
      backends: [
        {
          id: "github-api",
          run: async ({ query, limit }, ctx) => {
            if (!query?.trim()) throw new ReachChannelError("BAD_INPUT", "search 需要 query");
            const data = await ghFetch<{
              items?: Array<{
                full_name?: string;
                html_url?: string;
                description?: string;
                stargazers_count?: number;
                language?: string;
                pushed_at?: string;
                owner?: { login?: string };
                private: boolean;
              }>;
            }>(
              `/search/repositories?q=${encodeURIComponent(`${query} is:public`)}&sort=stars&per_page=${Math.min(limit, 25)}`,
              ctx,
            );
            if (!Array.isArray(data?.items))
              throw new ReachChannelError("UPSTREAM_BROKEN", "GitHub 搜索响应缺少仓库列表");
            return data.items
              .filter((r) => r.private === false)
              .map((r) =>
                makeItem({
                  title: r.full_name ?? "(无名仓库)",
                  url: r.html_url ?? "",
                  author: r.owner?.login ?? null,
                  publishedAt: r.pushed_at ?? null,
                  text: r.description ?? "",
                  // 搜索只有一句简介，不是 README 全文。
                  partial: true,
                  extra: {
                    ...(r.stargazers_count != null ? { stars: r.stargazers_count } : {}),
                    ...(r.language ? { language: r.language } : {}),
                  },
                }),
              );
          },
        },
      ],
    },
    {
      name: "read",
      description: "读取仓库 README，或某条 Issue / PR 的正文与评论",
      backends: [
        {
          id: "github-api",
          run: async ({ target, limit }, ctx) => {
            if (!target) throw new ReachChannelError("BAD_INPUT", "read 需要 target");
            const { owner, repo, number } = parseTarget(target);
            const meta = await ghFetch<{
              full_name?: string;
              html_url?: string;
              description?: string;
              stargazers_count?: number;
              pushed_at?: string;
              private: boolean;
            }>(`/repos/${owner}/${repo}`, ctx);
            if (meta.private !== false) {
              throw new ReachChannelError("BAD_INPUT", "跨平台检索只支持已确认公开的 GitHub 仓库");
            }
            if (number == null) {
              const readme = await ghFetch<{ content?: string; encoding?: string }>(
                `/repos/${owner}/${repo}/readme`,
                ctx,
              ).catch((error: unknown) => {
                if (error instanceof ReachChannelError && error.code === "NOT_FOUND") return null;
                throw error;
              });
              const text =
                readme?.content && readme.encoding === "base64"
                  ? Buffer.from(readme.content, "base64").toString("utf8")
                  : (meta.description ?? "");
              return [
                makeItem({
                  title: meta.full_name ?? `${owner}/${repo}`,
                  url: meta.html_url ?? `https://github.com/${owner}/${repo}`,
                  publishedAt: meta.pushed_at ?? null,
                  text,
                  partial: !readme?.content || readme.encoding !== "base64",
                  ...(meta.stargazers_count != null
                    ? { extra: { stars: meta.stargazers_count } }
                    : {}),
                }),
              ];
            }

            // Issue 接口同时覆盖 Issue 和 PR 的正文；注意这不是 diff，也不是逐行 review。
            const issue = await ghFetch<{
              title?: string;
              html_url?: string;
              body?: string;
              created_at?: string;
              user?: { login?: string };
              pull_request?: unknown;
              comments?: number;
            }>(`/repos/${owner}/${repo}/issues/${number}`, ctx);

            const head: ReachItem = makeItem({
              title: issue.title ?? `#${number}`,
              url: issue.html_url ?? `https://github.com/${owner}/${repo}/issues/${number}`,
              author: issue.user?.login ?? null,
              publishedAt: issue.created_at ?? null,
              text: issue.body ?? "",
              partial: false,
              extra: { kind: issue.pull_request ? "pull_request" : "issue" },
            });
            const commentLimit = Math.max(0, limit - 1);
            const comments =
              commentLimit && issue.comments !== 0
                ? await ghFetch<
                    Array<{
                      body?: string;
                      created_at?: string;
                      html_url?: string;
                      user?: { login?: string };
                    }>
                  >(
                    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${commentLimit}`,
                    ctx,
                  ).catch((error: unknown) => {
                    if (error instanceof ReachChannelError)
                      throw new ReachChannelError(
                        error.code,
                        error.message,
                        error.nextStep,
                        error.retryAfterSeconds,
                        [head],
                      );
                    throw error;
                  })
                : [];
            if (!Array.isArray(comments))
              throw new ReachChannelError("UPSTREAM_BROKEN", "GitHub 评论响应无效");
            head.extra = {
              ...head.extra,
              commentsReturned: Math.min(comments.length, commentLimit),
              commentsTruncated: issue.comments === undefined || issue.comments > commentLimit,
            };
            return [
              head,
              ...comments.slice(0, commentLimit).map((c, i) =>
                makeItem({
                  title: `评论 #${i + 1}`,
                  url: c.html_url ?? head.url,
                  author: c.user?.login ?? null,
                  publishedAt: c.created_at ?? null,
                  text: c.body ?? "",
                  partial: false,
                }),
              ),
            ];
          },
        },
      ],
    },
  ],
};
