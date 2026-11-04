import { ReachChannelError, makeItem, type ReachChannelDef, type ReachContext } from "../types";
import type { ReachItem } from "@agentdesk/shared";
import { checkReachResponse } from "../http";

const API = "https://www.v2ex.com";

interface V2exTopic {
  id?: number;
  title?: string;
  url?: string;
  content?: string;
  created?: number;
  replies?: number;
  member?: { username?: string };
  node?: { name?: string; title?: string };
}

interface V2exReply {
  content?: string;
  created?: number;
  member?: { username?: string };
}

const iso = (unix?: number) => (unix ? new Date(unix * 1000).toISOString() : null);

async function getJson<T>(path: string, ctx: ReachContext): Promise<T> {
  const response = await ctx.fetch(`${API}${path}`, {
    headers: { Accept: "application/json" },
    timeoutMs: Math.max(1000, ctx.deadline - Date.now()),
  });
  checkReachResponse(response, "V2EX");
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new ReachChannelError("UPSTREAM_BROKEN", "V2EX 返回的不是合法 JSON");
  }
}

function topicItem(t: V2exTopic, partial: boolean): ReachItem {
  return makeItem({
    title: t.title ?? "(无标题)",
    url: t.url ?? (t.id ? `${API}/t/${t.id}` : API),
    author: t.member?.username ?? null,
    publishedAt: iso(t.created),
    text: t.content ?? "",
    partial,
    extra: {
      ...(t.replies != null ? { replies: t.replies } : {}),
      ...(t.node?.name ? { node: t.node.name } : {}),
    },
  });
}

/** 接受主题 id 或 https://www.v2ex.com/t/<id> 链接。 */
function topicId(target: string): string {
  const m = /^(?:https?:\/\/)?(?:www\.)?v2ex\.com\/t\/([1-9]\d*)\/?(?:[?#].*)?$/.exec(
    target.trim(),
  );
  if (m) return m[1]!;
  if (/^[1-9]\d*$/.test(target.trim())) return target.trim();
  throw new ReachChannelError("BAD_INPUT", "target 需要是 V2EX 主题链接或主题 id");
}

export const v2exChannel: ReachChannelDef = {
  id: "v2ex",
  title: "V2EX",
  description: "V2EX 热门、节点主题、主题正文与回复",
  // 全部走 V2EX 自己的公开 API，不经任何第三方中转。
  sendsDataTo: ["www.v2ex.com"],
  requires: [],
  actions: [
    {
      name: "hot",
      description: "当前热门主题",
      backends: [
        {
          id: "v2ex-api",
          run: async ({ limit }, ctx) => {
            const topics = await getJson<V2exTopic[]>("/api/topics/hot.json", ctx);
            return topics.slice(0, limit).map((t) => topicItem(t, true));
          },
        },
      ],
    },
    {
      name: "node",
      description: "某个节点下的主题，target 传节点名（如 programmer）",
      backends: [
        {
          id: "v2ex-api",
          run: async ({ target, limit }, ctx) => {
            const node = (target ?? "").trim();
            if (!/^[a-zA-Z0-9_-]{1,50}$/.test(node))
              throw new ReachChannelError("BAD_INPUT", "target 需要是节点名，例如 programmer");
            const topics = await getJson<V2exTopic[]>(
              `/api/topics/show.json?node_name=${encodeURIComponent(node)}`,
              ctx,
            );
            if (topics.length === 0)
              throw new ReachChannelError("NOT_FOUND", `节点 ${node} 没有主题`);
            return topics.slice(0, limit).map((t) => topicItem(t, true));
          },
        },
      ],
    },
    {
      name: "read",
      description: "读取主题正文与回复",
      backends: [
        {
          id: "v2ex-api",
          run: async ({ target, limit }, ctx) => {
            const id = topicId(target ?? "");
            const topics = await getJson<V2exTopic[]>(`/api/topics/show.json?id=${id}`, ctx);
            const topic = topics[0];
            if (!topic) throw new ReachChannelError("NOT_FOUND", `找不到主题 ${id}`);
            const head = topicItem(topic, false);
            const replies =
              limit > 1
                ? await getJson<V2exReply[]>(
                    `/api/replies/show.json?topic_id=${id}&page=1`,
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
            head.extra = {
              ...head.extra,
              repliesReturned: Math.min(replies.length, limit - 1),
              repliesTruncated:
                topic.replies === undefined || topic.replies > Math.min(replies.length, limit - 1),
            };
            return [
              head,
              ...replies.slice(0, Math.max(0, limit - 1)).map((r, i) =>
                makeItem({
                  title: `回复 #${i + 1}`,
                  url: `${API}/t/${id}#reply${i + 1}`,
                  author: r.member?.username ?? null,
                  publishedAt: iso(r.created),
                  text: r.content ?? "",
                  partial: false,
                }),
              ),
            ];
          },
        },
      ],
    },
    {
      name: "user",
      description: "查看用户公开信息，target 传用户名",
      backends: [
        {
          id: "v2ex-api",
          run: async ({ target }, ctx) => {
            const name = (target ?? "").trim();
            if (!/^[a-zA-Z0-9_-]{1,50}$/.test(name))
              throw new ReachChannelError("BAD_INPUT", "target 需要是 V2EX 用户名");
            const user = await getJson<{
              username?: string;
              website?: string;
              bio?: string;
              created?: number;
              url?: string;
            }>(`/api/members/show.json?username=${encodeURIComponent(name)}`, ctx);
            if (!user.username) throw new ReachChannelError("NOT_FOUND", `找不到用户 ${name}`);
            return [
              makeItem({
                title: user.username,
                url: user.url ?? `${API}/member/${user.username}`,
                author: user.username,
                publishedAt: iso(user.created),
                text: [user.bio, user.website].filter(Boolean).join("\n"),
                partial: false,
              }),
            ];
          },
        },
      ],
    },
  ],
};
