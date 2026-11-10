import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@agentdesk/ui";
import { Markdown } from "../../components/Markdown";
import { api, type ArticleCodeTab, type DocsChapter } from "../../lib/api";

function samePage(a: string, b: string): boolean {
  const path = (value: string) => {
    try {
      return new URL(value).pathname.replace(/\/+$/, "");
    } catch {
      return value.replace(/\/+$/, "");
    }
  };
  return path(a) === path(b);
}

function ChapterNav({
  chapters,
  active,
  depth,
  onOpen,
}: {
  chapters: DocsChapter[];
  active: string;
  depth: number;
  onOpen: (url: string) => void;
}) {
  return (
    <ul className={cn("grid gap-0.5", depth > 0 && "mt-0.5")}>
      {chapters.map((chapter) => (
        <li key={`${chapter.title}-${chapter.url ?? "group"}`}>
          {chapter.url ? (
            <button
              type="button"
              onClick={() => onOpen(chapter.url!)}
              className={cn(
                "w-full truncate rounded-lg px-2.5 py-1.5 text-left text-[12.5px]",
                samePage(chapter.url, active)
                  ? "bg-brand/10 font-medium text-brand"
                  : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
              style={{ paddingLeft: 10 + depth * 12 }}
            >
              {chapter.title}
            </button>
          ) : (
            <p
              className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-subtle"
              style={{ paddingLeft: 10 + depth * 12 }}
            >
              {chapter.title}
            </p>
          )}
          {chapter.children.length ? (
            <ChapterNav
              chapters={chapter.children}
              active={active}
              depth={depth + 1}
              onOpen={onOpen}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CodeCard({ tabs }: { tabs: ArticleCodeTab[] }) {
  const [index, setIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const current = tabs[Math.min(index, tabs.length - 1)]!;
  return (
    <figure className="my-4 overflow-hidden rounded-2xl border border-white/10 bg-[#12161c] text-[#e7edf5] shadow-sm">
      <figcaption className="flex items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {tabs.map((tab, tabIndex) => (
            <button
              key={`${tab.label}-${tabIndex}`}
              type="button"
              onClick={() => setIndex(tabIndex)}
              className={cn(
                "shrink-0 rounded-lg px-2.5 py-1 text-[12px]",
                tabIndex === index ? "bg-white/15 text-white" : "text-white/55 hover:text-white",
              )}
            >
              {tab.label || tab.lang || "代码"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white"
          aria-label="复制代码"
          onClick={() => {
            void navigator.clipboard.writeText(current.code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </figcaption>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-6">
        <code>{current.code}</code>
      </pre>
    </figure>
  );
}

export function ArticleReader({ url }: { url: string }) {
  const [pageUrl, setPageUrl] = useState(url);
  const outline = useQuery({
    queryKey: ["learning-outline", url],
    queryFn: () => api.learningOutline(url),
  });
  const page = useQuery({
    queryKey: ["learning-page", pageUrl],
    queryFn: () => api.learningPage(pageUrl),
  });
  const headings = useMemo(
    () =>
      page.data?.blocks.flatMap((block) => (block.kind === "prose" ? block.headings : [])) ?? [],
    [page.data],
  );

  return (
    <div className="grid border-t bg-surface-2/30 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="max-h-80 overflow-y-auto border-b px-3 py-4 lg:max-h-[70vh] lg:border-r lg:border-b-0">
        {outline.data?.length ? (
          <ChapterNav chapters={outline.data} active={pageUrl} depth={0} onOpen={setPageUrl} />
        ) : (
          <ul className="grid gap-0.5">
            {headings.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  className="block truncate rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg"
                  style={{ paddingLeft: 10 + (heading.level - 1) * 12 }}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <article className="min-w-0 px-5 py-5 sm:px-8">
        {page.isLoading ? <p className="text-[13px] text-muted">正在读取这一节……</p> : null}
        {page.isError ? (
          <p className="text-[13px] text-danger">
            {page.error instanceof Error ? page.error.message : "这一节没有读出来"}
          </p>
        ) : null}
        {page.data?.blocks.map((block, index) =>
          block.kind === "code" ? (
            <CodeCard key={`code-${index}`} tabs={block.tabs} />
          ) : (
            <div key={`prose-${index}`} className="text-[14px] leading-7">
              <Markdown>{block.text}</Markdown>
            </div>
          ),
        )}
      </article>
    </div>
  );
}
