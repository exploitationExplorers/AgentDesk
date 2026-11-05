import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Presentation,
  X,
} from "lucide-react";
import type { AgentStreamEvent, Artifact } from "@agentdesk/shared";
import { Button, Spinner, cn } from "@agentdesk/ui";
import { useApiUrl } from "../../hooks/useApiUrl";
import { artifactsApi } from "../code/artifacts-api";
import { ArtifactPreview, staticHtml } from "../code/ArtifactWorkspace";
import { Markdown } from "../../components/Markdown";
import { PptxOfficeViewer } from "./PptxOfficeViewer";

type PanelMode = "docked" | "fullscreen" | "collapsed";

const PANEL_WIDTH_KEY = "agentdesk.preview-panel-width";
const PANEL_WIDTH_MIN = 360;
const PANEL_WIDTH_DEFAULT_WIDE = 620;
const PANEL_WIDTH_DEFAULT = 480;

function readStoredWidth(wide: boolean): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed >= PANEL_WIDTH_MIN) return parsed;
  } catch {
    /* ignore */
  }
  return wide ? PANEL_WIDTH_DEFAULT_WIDE : PANEL_WIDTH_DEFAULT;
}

function panelShellClass(mode: PanelMode): string {
  // z-50 keeps chrome controls above AppShell's theme toggle (z-40, top-right).
  if (mode === "fullscreen") {
    return "fixed inset-0 z-50 flex min-w-0 flex-col bg-surface";
  }
  if (mode === "collapsed") {
    return "absolute inset-y-0 right-0 z-50 flex w-12 flex-col border-l bg-surface xl:static xl:self-stretch";
  }
  return "absolute inset-0 z-50 flex min-w-0 flex-col border-l bg-surface xl:static xl:shrink-0";
}

function PreviewShell({
  ariaLabel,
  icon,
  title,
  status,
  downloadUrl,
  mode,
  onModeChange,
  onClose,
  titleExtra,
  wide,
  embedHeader,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  downloadUrl?: string | null;
  mode: PanelMode;
  onModeChange: (mode: PanelMode) => void;
  onClose: () => void;
  titleExtra?: ReactNode;
  /** PPT 等需要更大预览区 */
  wide?: boolean;
  /** Office 编辑器自带标题栏时，把下载等控件并入顶栏，避免双层标题 */
  embedHeader?: boolean;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(() => readStoredWidth(Boolean(wide)));
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, [width]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const max = Math.floor(window.innerWidth * 0.75);
      const next = Math.min(
        max,
        Math.max(PANEL_WIDTH_MIN, drag.startWidth + (drag.startX - event.clientX)),
      );
      setWidth(next);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  if (mode === "collapsed") {
    return (
      <aside aria-label={ariaLabel} className={panelShellClass(mode)}>
        <div className="flex flex-1 flex-col items-center gap-2 pt-14 pb-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="展开右侧面板"
            onClick={() => onModeChange("docked")}
          >
            <PanelRightOpen className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="关闭成果预览" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label={ariaLabel}
      className={cn(
        panelShellClass(mode),
        "relative",
        mode === "docked" && "xl:w-[var(--preview-panel-w)]",
      )}
      style={
        mode === "docked" ? ({ ["--preview-panel-w"]: `${width}px` } as CSSProperties) : undefined
      }
    >
      {mode === "docked" ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整预览面板宽度"
          aria-valuemin={PANEL_WIDTH_MIN}
          aria-valuemax={Math.floor(
            typeof window === "undefined" ? 1200 : window.innerWidth * 0.75,
          )}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            dragRef.current = { startX: event.clientX, startWidth: width };
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft")
              setWidth((w) => Math.min(Math.floor(window.innerWidth * 0.75), w + 24));
            if (event.key === "ArrowRight") setWidth((w) => Math.max(PANEL_WIDTH_MIN, w - 24));
          }}
          className="absolute inset-y-0 left-0 z-20 hidden w-1.5 -translate-x-1/2 cursor-col-resize xl:block"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border hover:bg-brand" />
        </div>
      ) : null}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        {embedHeader ? (
          <>
            <div className="min-w-0 flex-1 px-1">{title}</div>
            {status ? <span className="shrink-0 text-xs text-muted">{status}</span> : null}
            {downloadUrl ? (
              <a
                href={downloadUrl}
                download
                className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
              >
                <Download className="h-4 w-4" />
                下载
              </a>
            ) : null}
          </>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={mode === "fullscreen" ? "退出全屏" : "进入全屏"}
          onClick={() => onModeChange(mode === "fullscreen" ? "docked" : "fullscreen")}
        >
          {mode === "fullscreen" ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </Button>
        {mode === "docked" ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="收起右侧面板"
            onClick={() => onModeChange("collapsed")}
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        ) : null}
        <Button variant="ghost" size="icon" aria-label="关闭成果预览" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {embedHeader ? null : (
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4">
          {icon}
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          {titleExtra}
          {status ? <span className="shrink-0 text-xs text-muted">{status}</span> : null}
          {downloadUrl ? (
            <a
              href={downloadUrl}
              download
              className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
            >
              <Download className="h-4 w-4" />
              下载
            </a>
          ) : null}
        </header>
      )}
      {children}
    </aside>
  );
}

export function LiveDocumentPanel({
  document,
  onClose,
}: {
  document: Extract<AgentStreamEvent, { type: "document_preview" }>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<PanelMode>("docked");
  return (
    <PreviewShell
      ariaLabel="生成中的文档"
      icon={<FileText className="h-4 w-4 shrink-0 text-brand" />}
      title={document.title}
      status={`已写 ${document.completed} / ${document.total} 章`}
      mode={mode}
      onModeChange={setMode}
      onClose={onClose}
    >
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
    </PreviewShell>
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
  const [mode, setMode] = useState<PanelMode>("docked");
  return (
    <PreviewShell
      ariaLabel="生成中的演示文稿"
      icon={<Presentation className="h-4 w-4 shrink-0 text-brand" />}
      title={title ?? slides[0]?.deckTitle ?? "演示文稿"}
      status={progress ?? "生成中"}
      mode={mode}
      onModeChange={setMode}
      onClose={onClose}
    >
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
    </PreviewShell>
  );
}

function metadata(artifact: Artifact): {
  role?: string;
  format?: string;
  previewArtifactId?: string;
  slideCount?: number;
  status?: string;
  sectionCount?: number;
  storage?: string;
} {
  return artifact.metadata && typeof artifact.metadata === "object" ? artifact.metadata : {};
}

/** 仅真正的 .pptx 走 office 预览；草稿阶段是 HTML/SVG，不能塞进 pptx-preview。 */
function isPptxArtifact(artifact: Artifact): boolean {
  const mime = artifact.mimeType ?? "";
  if (mime.includes("presentationml.presentation")) return true;
  if (/\.pptx$/i.test(artifact.title)) return true;
  return false;
}

function isSlideDeckArtifact(artifact: Artifact): boolean {
  const meta = metadata(artifact);
  return Boolean(meta.slideCount) || meta.format === "slides" || isPptxArtifact(artifact);
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
          {isSlideDeckArtifact(artifact) ? (
            <Presentation className="h-7 w-7 shrink-0 text-brand" />
          ) : (
            <FileText className="h-7 w-7 shrink-0 text-brand" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{artifact.title}</span>
            <span className="mt-1 block text-xs text-muted">
              {metadata(artifact).slideCount
                ? `${metadata(artifact).slideCount} 页 · ${
                    isPptxArtifact(artifact)
                      ? "PowerPoint"
                      : metadata(artifact).status === "draft"
                        ? "演示文稿"
                        : "幻灯片"
                  }`
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
  const [mode, setMode] = useState<PanelMode>("docked");
  const meta = metadata(artifact);
  const isPptx = isPptxArtifact(artifact);
  const isSlideDeck = isSlideDeckArtifact(artifact);
  const previewId = meta.previewArtifactId;
  const view = useQuery({
    queryKey: [
      "artifact-content",
      "workbench",
      artifact.taskId,
      isPptx ? (previewId ?? artifact.id) : artifact.id,
    ],
    queryFn: () => client.content(artifact.taskId, isPptx && previewId ? previewId : artifact.id),
    enabled: !isPptx,
  });
  const slides = useMemo((): SlidePage[] => {
    if (!view.data) return [];
    const viewMeta = metadata(view.data.artifact);
    if (viewMeta.format !== "slides" && !viewMeta.slideCount) return [];
    const document = new DOMParser().parseFromString(view.data.content, "text/html");
    return [...document.querySelectorAll("section[data-slide]")].map((node) => ({
      title: node.getAttribute("aria-label") ?? "幻灯片",
      html: node.outerHTML,
    }));
  }, [view.data]);
  const download = useApiUrl(
    isPptx || meta.status !== "draft" ? client.downloadPath(artifact.taskId, artifact.id) : null,
  );

  return (
    <PreviewShell
      ariaLabel="成果预览"
      wide={isSlideDeck}
      embedHeader={isPptx}
      icon={
        isSlideDeck ? (
          <Presentation className="h-4 w-4 shrink-0 text-brand" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-brand" />
        )
      }
      title={
        <select
          aria-label="选择预览成果"
          value={artifact.id}
          onChange={(event) => onSelect(event.target.value)}
          className="w-full min-w-0 rounded-md bg-transparent py-1 text-sm focus-visible:outline-brand"
        >
          {artifacts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      }
      downloadUrl={download}
      mode={mode}
      onModeChange={setMode}
      onClose={onClose}
    >
      {isPptx && download ? (
        <PptxOfficeViewer key={artifact.id} url={download} fileName={artifact.title} />
      ) : slides.length ? (
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
    </PreviewShell>
  );
}
