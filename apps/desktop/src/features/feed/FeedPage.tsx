import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Bot,
  ExternalLink,
  Flame,
  Newspaper,
  RefreshCw,
  Search,
  Sparkles,
  Star,
} from "lucide-react";
import { useState } from "react";
import type { FeedItem, FeedSource, FeedTag } from "@agentdesk/shared";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Segmented,
  Select,
  Spinner,
  cn,
} from "@agentdesk/ui";
import { Markdown } from "../../components/Markdown";
import { api } from "../../lib/api";
import { compactNumber, todayLocal } from "../../lib/format";
import { useUi } from "../../stores/ui";

const SOURCE_LABEL: Record<FeedSource, string> = {
  github: "GitHub",
  huggingface: "HuggingFace",
  hackernews: "Hacker News",
};
const TAG_LABEL: Record<FeedTag, string> = {
  ai: "AI",
  frontend: "前端",
  backend: "后端",
  devops: "DevOps",
  mobile: "移动端",
  other: "其他",
};

function FeedCard({ item, onExplain }: { item: FeedItem; onExplain: () => void }) {
  const queryClient = useQueryClient();
  const fav = useMutation({
    mutationFn: () => api.toggleFavorite(item.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["feed", "list"] }),
  });
  return (
    <Card className="group flex flex-col p-4 transition-colors hover:border-border-strong">
      <div className="flex items-start gap-2">
        <a href={item.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold group-hover:text-brand">{item.title}</p>
        </a>
        <button
          type="button"
          aria-label="收藏"
          onClick={() => fav.mutate()}
          className={cn(
            "rounded-md p-1 transition-colors",
            item.favorite ? "text-warning" : "text-subtle hover:text-fg",
          )}
        >
          <Star className={cn("h-4 w-4", item.favorite && "fill-current")} />
        </button>
      </div>
      <p className="mt-2 line-clamp-3 flex-1 text-[12.5px] leading-5 text-muted">
        {item.summaryZh || item.description || "暂无描述"}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge>{SOURCE_LABEL[item.source]}</Badge>
        {item.tags.map((t) => (
          <Badge key={t} tone={t === "ai" ? "brand" : "neutral"}>
            {TAG_LABEL[t]}
          </Badge>
        ))}
        {item.language ? <span className="text-[11px] text-subtle">{item.language}</span> : null}
        <span className="ml-auto flex items-center gap-2 text-[11.5px] text-subtle">
          {item.stars != null ? (
            <span className="flex items-center gap-0.5">
              <Star className="h-3 w-3" />
              {compactNumber(item.stars)}
            </span>
          ) : null}
          {item.starsToday ? (
            <span className="flex items-center gap-0.5 text-warning">
              <Flame className="h-3 w-3" />+{compactNumber(item.starsToday)}
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-3 flex gap-1.5 border-t pt-3 opacity-70 transition-opacity group-hover:opacity-100">
        <Button size="sm" variant="ghost" onClick={onExplain}>
          <Bot className="h-3.5 w-3.5" />让 Bot 讲解
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={item.url} target="_blank" rel="noreferrer">
            <ExternalLink className="h-3.5 w-3.5" />
            打开
          </a>
        </Button>
      </div>
    </Card>
  );
}

export function FeedPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setChatPrefill = useUi((s) => s.setChatPrefill);
  const [date, setDate] = useState(todayLocal());
  const [source, setSource] = useState<"all" | FeedSource | "favorite">("all");
  const [tag, setTag] = useState<"" | FeedTag>("");
  const [q, setQ] = useState("");

  const dates = useQuery({ queryKey: ["feed", "dates"], queryFn: api.feedDates });
  const items = useQuery({
    queryKey: ["feed", "list", date, source, tag, q],
    queryFn: () =>
      api.feed({
        date: source === "favorite" ? undefined : date,
        source: source === "all" || source === "favorite" ? undefined : source,
        favorite: source === "favorite" ? "true" : undefined,
        tag: tag || undefined,
        q: q || undefined,
      }),
  });
  const digest = useQuery({ queryKey: ["feed", "digest", date], queryFn: () => api.digest(date) });
  const refresh = useMutation({
    mutationFn: api.refreshFeed,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["feed"] }),
  });
  const generate = useMutation({
    mutationFn: () => api.generateDigest(date),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["feed", "digest", date] }),
  });

  const dateOptions = Array.from(new Set([todayLocal(), ...(dates.data ?? [])]));
  const explain = (item: FeedItem) => {
    setChatPrefill({
      message: `深入讲解这个项目：${item.title}（${item.url}）。它解决什么问题、核心原理、和同类方案相比的优劣、我该怎么上手？`,
      agent: "research",
    });
    void navigate({ to: "/", search: {} });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          icon={<Newspaper className="h-5 w-5" />}
          title="技术热榜"
          description="每日 GitHub Trending、HuggingFace、Hacker News，AI 中文摘要与分类"
          actions={
            <>
              <Select value={date} onChange={(e) => setDate(e.target.value)} className="w-36">
                {dateOptions.map((d) => (
                  <option key={d} value={d}>
                    {d === todayLocal() ? `今天 ${d.slice(5)}` : d}
                  </option>
                ))}
              </Select>
              <Button
                variant="primary"
                loading={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                立即抓取
              </Button>
            </>
          }
        />
        {refresh.data ? (
          <p className="mb-4 text-[12.5px] text-muted">
            抓取 {refresh.data.fetched} 条，生成摘要 {refresh.data.summarized} 条
            {refresh.data.errors.length ? (
              <span className="text-warning"> · {refresh.data.errors.join("；")}</span>
            ) : null}
          </p>
        ) : null}
        {refresh.error ? (
          <p className="mb-4 text-[12.5px] text-danger">{refresh.error.message}</p>
        ) : null}

        <Card className="ad-glow mb-6 overflow-hidden p-5">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <span className="text-[13px] font-semibold">今日速览</span>
            <Button
              className="ml-auto"
              size="sm"
              variant="ghost"
              loading={generate.isPending}
              onClick={() => generate.mutate()}
            >
              {digest.data ? "重新生成" : "生成速览"}
            </Button>
          </div>
          {digest.data ? (
            <>
              <p className="mb-2 text-[16px] font-semibold tracking-tight">
                {digest.data.headline}
              </p>
              <Markdown>{digest.data.markdown}</Markdown>
            </>
          ) : (
            <p className="text-[13px] text-muted">
              {generate.error
                ? generate.error.message
                : "让 Research Agent 从今天的热榜里挑出最值得关注的内容，生成一份中文速览。"}
            </p>
          )}
        </Card>

        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Segmented
            value={source}
            onChange={setSource}
            options={[
              { value: "all", label: "全部" },
              { value: "github", label: "GitHub" },
              { value: "huggingface", label: "HuggingFace" },
              { value: "hackernews", label: "HN" },
              { value: "favorite", label: "收藏" },
            ]}
          />
          <Segmented
            value={tag}
            onChange={setTag}
            options={[
              { value: "" as const, label: "全部领域" },
              ...(Object.keys(TAG_LABEL) as FeedTag[]).map((t) => ({
                value: t,
                label: TAG_LABEL[t],
              })),
            ]}
          />
          <div className="relative ml-auto w-60">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索"
              className="pl-8"
            />
          </div>
        </div>

        {items.isLoading ? (
          <Spinner />
        ) : items.data?.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.data.map((item) => (
              <FeedCard key={item.id} item={item} onExplain={() => explain(item)} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Newspaper className="h-6 w-6" />}
            title="这里还没有内容"
            description="点击“立即抓取”获取今日热榜；之后会按设置中的时间每天自动抓取。"
          />
        )}
      </div>
    </div>
  );
}
