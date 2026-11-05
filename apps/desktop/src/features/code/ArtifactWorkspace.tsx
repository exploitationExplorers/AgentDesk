import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Pencil, Save, X } from "lucide-react";
import type { Artifact, ArtifactContent } from "@agentdesk/shared";
import {
  AnimatePresence,
  Badge,
  Button,
  EmptyState,
  Select,
  Spinner,
  Textarea,
  cn,
  crossfadeVariants,
  motion,
} from "@agentdesk/ui";
import { Markdown } from "../../components/Markdown";
import { useApiUrl } from "../../hooks/useApiUrl";
import { artifactsApi } from "./artifacts-api";
import type { CodeSource } from "./api";

const KIND_LABELS: Record<Artifact["kind"], string> = {
  plan: "方案",
  change: "代码变更",
  test_result: "验证结果",
  file: "文件",
  summary: "报告",
};

function keyOf(artifact: Artifact): string {
  return artifact.artifactKey ?? `${artifact.kind}:${artifact.filePath ?? ""}`;
}

/** 沙箱内仅展示静态 HTML，去除可导航元素以及外部资源。 */
export function staticHtml(content: string): string {
  const document = new DOMParser().parseFromString(content, "text/html");
  for (const node of document.querySelectorAll(
    "script, iframe, frame, frameset, object, embed, form, meta, base, link",
  ))
    node.remove();
  for (const node of document.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        ["srcset", "action", "formaction", "target", "ping", "xlink:href"].includes(name)
      )
        node.removeAttribute(attribute.name);
      if (
        (name === "href" && !attribute.value.startsWith("#")) ||
        (name === "src" && !/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(attribute.value))
      )
        node.removeAttribute(attribute.name);
    }
  }
  const styles = [...document.head.querySelectorAll("style")]
    .map((node) => node.outerHTML)
    .join("");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${styles}</head><body>${document.body.innerHTML}</body></html>`;
}

export function ArtifactWorkspace({
  taskId,
  source = "workbench",
}: {
  taskId: string;
  source?: CodeSource;
}) {
  const client = artifactsApi(source);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const list = useQuery({
    queryKey: ["artifacts", source, taskId],
    queryFn: () => client.list(taskId),
    refetchInterval: 5000,
  });
  const groups = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const artifact of list.data ?? [])
      map.set(keyOf(artifact), [...(map.get(keyOf(artifact)) ?? []), artifact]);
    return [...map.entries()].map(([key, items]) => ({
      key,
      items: items.sort((a, b) => a.version - b.version),
    }));
  }, [list.data]);
  const group = groups.find((entry) => entry.key === activeKey) ?? groups[0];
  const selected = group?.items.find((item) => item.id === versionId) ?? group?.items.at(-1);
  const previous = selected
    ? group?.items.filter((item) => item.version < selected.version).at(-1)
    : undefined;
  const view = useQuery({
    queryKey: ["artifact-content", source, taskId, selected?.id],
    queryFn: () => client.content(taskId, selected!.id),
    enabled: !!selected,
  });
  const previousView = useQuery({
    queryKey: ["artifact-content", source, taskId, previous?.id],
    queryFn: () => client.content(taskId, previous!.id),
    enabled: compare && !!previous,
  });
  const download = useApiUrl(selected ? client.downloadPath(taskId, selected.id) : null);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="成果工作区">
      {list.isLoading ? (
        <Spinner className="m-5" />
      ) : list.error ? (
        <p className="p-4 text-sm text-danger">{list.error.message}</p>
      ) : !groups.length ? (
        <EmptyState
          title="还没有成果"
          description="任务生成的方案、报告、代码变更和文件会显示在这里。"
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <FileText className="h-4 w-4 shrink-0 text-subtle" />
            <Select
              className="min-w-0 flex-1"
              aria-label="选择成果"
              value={group?.key ?? ""}
              onChange={(event) => {
                setActiveKey(event.target.value);
                setVersionId(null);
                setCompare(false);
              }}
            >
              {groups.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.items.at(-1)?.title}
                </option>
              ))}
            </Select>
            <Select
              className="w-24"
              aria-label="成果版本"
              value={selected?.id ?? ""}
              onChange={(event) => setVersionId(event.target.value)}
            >
              {group?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  v{item.version}
                </option>
              ))}
            </Select>
            {download ? (
              <a
                href={download}
                download
                className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-xs text-muted hover:bg-surface-2"
                aria-label="下载成果"
              >
                <Download className="h-3.5 w-3.5" />
                下载
              </a>
            ) : null}
          </div>
          {selected ? (
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[11px] text-subtle">
              <Badge>{KIND_LABELS[selected.kind]}</Badge>
              <span>{new Date(selected.createdAt).toLocaleString()}</span>
              {selected.runId ? (
                <span title={selected.runId}>来源 Run {selected.runId.slice(0, 8)}</span>
              ) : (
                <span>手动记录</span>
              )}
              {selected.filePath ? (
                <span className="w-full truncate font-mono" title={selected.filePath}>
                  {selected.filePath}
                </span>
              ) : null}
            </div>
          ) : null}
          {view.isLoading ? (
            <Spinner className="m-5" />
          ) : view.error ? (
            <p className="p-4 text-sm text-danger">{view.error.message}</p>
          ) : view.data && selected ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {view.data.source === "file" ? (
                <p className="mb-3 text-xs text-subtle">当前文件内容，此成果未保存历史快照。</p>
              ) : null}
              {view.data.changedOnDisk ? (
                <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                  项目文件已变化或被删除，这里显示保存的成果版本。
                </p>
              ) : null}
              {previous ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCompare((value) => !value)}
                  className="mb-3"
                >
                  {compare ? "关闭版本对比" : "对比上一版本"}
                </Button>
              ) : null}
              {compare && previous ? (
                <div className="mb-4 grid gap-3 xl:grid-cols-2">
                  <div>
                    <p className="mb-2 text-xs text-subtle">上一版本 v{previous.version}</p>
                    {previousView.data ? (
                      <Preview view={previousView.data} raw />
                    ) : previousView.error ? (
                      <p className="text-xs text-danger">{previousView.error.message}</p>
                    ) : (
                      <Spinner />
                    )}
                  </div>
                  <div>
                    <p className="mb-2 text-xs text-subtle">当前版本 v{selected.version}</p>
                    <Preview view={view.data} raw />
                  </div>
                </div>
              ) : (
                <AnimatePresence mode="wait">
                  <motion.div
                    key={selected.id}
                    variants={crossfadeVariants}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <ArtifactEditor
                      taskId={taskId}
                      source={source}
                      view={view.data}
                      latest={selected.id === group?.items.at(-1)?.id}
                      onSaved={(artifact) => setVersionId(artifact.id)}
                    />
                  </motion.div>
                </AnimatePresence>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function ArtifactPreview({ view, raw = false }: { view: ArtifactContent; raw?: boolean }) {
  const html = useMemo(
    () => (view.mimeType === "text/html" ? staticHtml(view.content) : ""),
    [view.mimeType, view.content],
  );
  if (view.encoding === "base64")
    return /^image\/(png|jpeg|gif|webp|avif)$/.test(view.mimeType) ? (
      <img
        src={`data:${view.mimeType};base64,${view.content}`}
        alt={view.artifact.title}
        className="max-h-[600px] max-w-full rounded-lg"
      />
    ) : (
      <p className="text-sm text-subtle">此文件类型请下载后查看。</p>
    );
  if (view.mimeType === "text/html" && !raw)
    return (
      <iframe
        title="HTML 成果预览"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html}
        className="h-[500px] w-full rounded-lg border bg-white"
      />
    );
  if (view.mimeType === "text/markdown" && !raw) return <Markdown>{view.content}</Markdown>;
  return (
    <pre
      className={cn(
        "overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-xs leading-6",
        raw && "max-h-[600px] overflow-y-auto",
      )}
    >
      {view.content}
    </pre>
  );
}

const Preview = ArtifactPreview;

function ArtifactEditor({
  taskId,
  source,
  view,
  latest,
  onSaved,
}: {
  taskId: string;
  source: CodeSource;
  view: ArtifactContent;
  latest: boolean;
  onSaved: (artifact: Artifact) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.content);
  const save = useMutation({
    mutationFn: () =>
      artifactsApi(source).revise(taskId, view.artifact.id, {
        baseVersion: view.artifact.version,
        content: draft,
      }),
    onSuccess: async (artifact) => {
      await queryClient.invalidateQueries({ queryKey: ["artifacts", source, taskId] });
      onSaved(artifact);
      setEditing(false);
    },
  });
  return (
    <>
      {source !== "cli" && view.editable && latest ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                loading={save.isPending}
                disabled={save.isPending || draft === view.content}
                onClick={() => save.mutate()}
              >
                <Save className="h-3.5 w-3.5" />
                保存新版本
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setEditing(false);
                  setDraft(view.content);
                  save.reset();
                }}
              >
                <X className="h-3.5 w-3.5" />
                取消
              </Button>
              <p className="w-full text-xs text-subtle">
                编辑会保存成果快照的新版本，项目文件仍由编码任务修改。
              </p>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
              编辑成果
            </Button>
          )}
        </div>
      ) : null}
      {save.error ? <p className="mb-3 text-xs text-danger">{save.error.message}</p> : null}
      {editing ? (
        <Textarea
          aria-label="成果正文"
          className="min-h-[360px] font-mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={save.isPending}
        />
      ) : (
        <Preview view={view} />
      )}
    </>
  );
}
