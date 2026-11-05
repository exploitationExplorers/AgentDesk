import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, FileText, Presentation, X } from "lucide-react";
import type { AgentStreamEvent, Artifact } from "@agentdesk/shared";
import { Button, Spinner } from "@agentdesk/ui";
import { useApiUrl } from "../../hooks/useApiUrl";
import { artifactsApi } from "../code/artifacts-api";
import { ArtifactPreview, staticHtml } from "../code/ArtifactWorkspace";
import { Markdown } from "../../components/Markdown";

export function LiveDocumentPanel({
  document,
  onClose,
}: {
  document: Extract<AgentStreamEvent, { type: "document_preview" }>;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="生成中的文档"
      className="absolute inset-0 z-30 flex min-w-0 flex-col border-l bg-surface xl:static xl:w-[46%] xl:min-w-[420px] xl:max-w-[900px] xl:shrink-0"
    >
      <header className="flex min-h-14 items-center gap-2 border-b px-4">
        <FileText className="h-4 w-4 shrink-0 text-brand" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{document.title}</h2>
        <span className="shrink-0 text-xs text-muted">
          已写 {document.completed} / {document.total} 章
        </span>
        <Button variant="ghost" size="icon" aria-label="关闭成果预览" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-surface-2/50 p-4 sm:p-6">
        <article className="min-h-full rounded-sm border bg-surface p-5 sm:p-8">
          {document.content ? (
            <Markdown>{document.content}</Markdown>
          ) : (
            <p role="status" className="text-sm text-muted">
              正在撰写第一章…
            </p>
          )}
        </article>
      </div>
    </aside>
  );
}

type Slide = Extract<AgentStreamEvent, { type: "presentation_slide" }>;
type SlidePage = { title: string; html: string };

function slideDocument(html: string): string {
  return staticHtml(
    `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}section,svg{display:block;width:100%;height:100%}</style>${html}`,
  );
}

function PresentationViewer({
  pages,
  following = false,
}: {
  pages: SlidePage[];
  following?: boolean;
}) {
  const [selection, setSelection] = useState<number | null>(following ? null : 0);
  const index = Math.min(
    selection ?? (following ? pages.length - 1 : 0),
    Math.max(pages.length - 1, 0),
  );
  const selected = pages[index];
  return (
    <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <nav
        aria-label="幻灯片页面"
        className="flex max-h-28 gap-2 overflow-auto border-b bg-surface-2/40 p-2 xl:max-h-none xl:w-36 xl:flex-col xl:border-b-0 xl:border-r xl:p-3"
      >
        {pages.map((page, number) => (
          <button
            key={number}
            type="button"
            onClick={() => setSelection(number)}
            aria-label={`第 ${number + 1} 页：${page.title}`}
            aria-current={number === index ? "page" : undefined}
            className={`flex w-32 shrink-0 flex-col gap-1 text-left text-xs xl:w-full ${number === index ? "text-brand" : "text-muted"}`}
          >
            <span
              className={`block aspect-video w-full overflow-hidden rounded-sm border bg-white ${number === index ? "border-brand ring-1 ring-brand" : "border-border"}`}
            >
              <iframe
                title={`第 ${number + 1} 页缩略图`}
                sandbox=""
                referrerPolicy="no-referrer"
                tabIndex={-1}
                aria-hidden="true"
                srcDoc={slideDocument(page.html)}
                className="pointer-events-none h-full w-full"
              />
            </span>
            <span className="truncate">
              {number + 1}. {page.title}
            </span>
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-2/50 p-3 sm:p-6">
          {selected ? (
            <iframe
              title="HTML 成果预览"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={slideDocument(selected.html)}
              className="aspect-video w-full max-w-[1200px] flex-none rounded-sm border bg-white shadow-sm"
            />
          ) : null}
        </div>
        <footer className="flex items-center justify-between border-t px-4 py-2">
          <Button
            variant="ghost"
            disabled={index === 0}
            onClick={() => setSelection(index - 1)}
            aria-label="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted">
            第 {index + 1} / {pages.length} 页
          </span>
          <Button
            variant="ghost"
            disabled={index === pages.length - 1}
            onClick={() => setSelection(index + 1)}
            aria-label="下一页"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </footer>
      </div>
    </div>
  );
}

export function LivePresentationPanel({
  slides,
  progress,
  title,
  onClose,
}: {
  slides: Slide[];
  progress: string | null;
  title?: string;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="生成中的演示文稿"
      className="absolute inset-0 z-30 flex min-w-0 flex-col border-l bg-surface xl:static xl:w-[46%] xl:min-w-[420px] xl:max-w-[900px] xl:shrink-0"
    >
      <header className="flex min-h-14 items-center gap-2 border-b px-4">
        <Presentation className="h-4 w-4 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {title ?? slides[0]?.deckTitle ?? "演示文稿"}
        </span>
        <span className="shrink-0 text-xs text-muted">{progress ?? "生成中"}</span>
        <Button variant="ghost" size="icon" aria-label="关闭成果预览" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>
      {slides.length ? (
        <PresentationViewer
          key={slides[0]?.presentationId ?? slides[0]?.deckTitle}
          following
          pages={slides.map((slide) => ({ title: slide.title, html: slide.svg }))}
        />
      ) : (
        <div
          role="status"
          className="grid min-h-0 flex-1 place-items-center bg-surface-2/50 p-6 text-sm text-muted"
        >
          正在准备第一页…
        </div>
      )}
    </aside>
  );
}

function metadata(artifact: Artifact): {
  role?: string;
  format?: string;
  previewArtifactId?: string;
  slideCount?: number;
  status?: string;
  sectionCount?: number;
} {
  return artifact.metadata && typeof artifact.metadata === "object" ? artifact.metadata : {};
}

export function visibleArtifacts(artifacts: Artifact[]): Artifact[] {
  const latest = new Map<string, Artifact>();
  for (const item of artifacts) {
    if (metadata(item).role === "preview" || item.kind === "change" || item.kind === "test_result")
      continue;
    const key = item.artifactKey ?? item.id;
    if ((latest.get(key)?.version ?? 0) < item.version) latest.set(key, item);
  }
  return [...latest.values()];
}

export function ArtifactCards({
  artifacts,
  onOpen,
}: {
  artifacts: Artifact[];
  onOpen: (id: string) => void;
}) {
  if (!artifacts.length) return null;
  return (
    <section aria-label="本次成果" className="space-y-2">
      {artifacts.map((artifact) => (
        <button
          key={artifact.id}
          type="button"
          onClick={() => onOpen(artifact.id)}
          className="flex w-full items-center gap-3 rounded-lg border bg-surface-2/70 p-4 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
        >
          {metadata(artifact).slideCount ? (
            <Presentation className="h-7 w-7 shrink-0 text-brand" />
          ) : (
            <FileText className="h-7 w-7 shrink-0 text-brand" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{artifact.title}</span>
            <span className="mt-1 block text-xs text-muted">
              {metadata(artifact).slideCount
                ? `${metadata(artifact).slideCount} 页 · PowerPoint`
                : artifact.title.endsWith(".docx")
                  ? "Word 文档"
                  : "文档"}{" "}
              {metadata(artifact).status === "draft" ? "· 已生成内容 " : ""}· 点击预览
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
        </button>
      ))}
    </section>
  );
}

export function ChatArtifactPanel({
  artifact,
  artifacts,
  onSelect,
  onClose,
}: {
  artifact: Artifact;
  artifacts: Artifact[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const client = artifactsApi();
  const isPresentation = !!metadata(artifact).slideCount;
  const previewId = metadata(artifact).previewArtifactId;
  const view = useQuery({
    queryKey: ["artifact-content", "workbench", artifact.taskId, previewId ?? artifact.id],
    queryFn: () => client.content(artifact.taskId, previewId ?? artifact.id),
  });
  const slides = useMemo((): SlidePage[] => {
    if (!view.data || metadata(view.data.artifact).format !== "slides") return [];
    const document = new DOMParser().parseFromString(view.data.content, "text/html");
    return [...document.querySelectorAll("section[data-slide]")].map((node) => ({
      title: node.getAttribute("aria-label") ?? "幻灯片",
      html: node.outerHTML,
    }));
  }, [view.data]);
  const download = useApiUrl(client.downloadPath(artifact.taskId, artifact.id));
  return (
    <aside
      aria-label="成果预览"
      className="absolute inset-0 z-30 flex min-w-0 flex-col border-l bg-surface xl:static xl:w-[46%] xl:min-w-[420px] xl:max-w-[900px] xl:shrink-0"
    >
      <header className="flex min-h-14 items-center gap-2 border-b px-4">
        {isPresentation ? (
          <Presentation className="h-4 w-4 shrink-0 text-brand" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-brand" />
        )}
        <select
          aria-label="选择预览成果"
          value={artifact.id}
          onChange={(event) => onSelect(event.target.value)}
          className="min-w-0 flex-1 rounded-md bg-transparent py-2 text-sm focus-visible:outline-brand"
        >
          {artifacts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
        {download ? (
          <a
            href={download}
            download
            className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
          >
            <Download className="h-4 w-4" />
            下载
          </a>
        ) : null}
        <Button variant="ghost" size="icon" aria-label="关闭成果预览" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>
      {slides.length ? (
        <PresentationViewer pages={slides} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-surface-2/50 p-4 sm:p-6">
          {view.isLoading ? (
            <div role="status" className="flex items-center gap-2 text-sm text-muted">
              <Spinner />
              正在打开成果…
            </div>
          ) : view.error ? (
            <p role="alert" className="text-sm text-muted">
              暂时无法打开预览，请稍后重试或下载文件查看。
            </p>
          ) : view.data ? (
            metadata(artifact).sectionCount ? (
              <article className="min-h-full rounded-sm border bg-surface p-5 sm:p-8">
                <ArtifactPreview view={view.data} />
              </article>
            ) : (
              <ArtifactPreview view={view.data} />
            )
          ) : null}
        </div>
      )}
    </aside>
  );
}
