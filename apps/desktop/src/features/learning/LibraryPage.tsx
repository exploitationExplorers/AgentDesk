import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronDown, FileText, Link2, Quote, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  AnimatePresence,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Segmented,
  Spinner,
  Textarea,
  cn,
  gridItemVariants,
  listItemVariants,
  motion,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { LearningNav } from "./LearningNav";

export function LibraryPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const sources = useQuery({ queryKey: ["learning-sources"], queryFn: api.learningSources });

  const importMut = useMutation({
    mutationFn: () =>
      api.importSource(
        mode === "url"
          ? { url: url.trim(), title: title.trim() || undefined }
          : { text: text.trim(), title: title.trim() || undefined },
      ),
    onSuccess: async () => {
      setUrl("");
      setText("");
      setTitle("");
      await queryClient.invalidateQueries({ queryKey: ["learning-sources"] });
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["learning-today"] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteSource(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["learning-sources"] });
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
  });

  const canSubmit = mode === "url" ? url.trim().length > 8 : text.trim().length >= 50;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-8 py-8">
        <PageHeader
          title="资料库"
          description="把链接或正文导进来，它会拆成可引用的知识点并排进复习队列"
          icon={<BookOpen className="h-5 w-5" />}
          actions={<LearningNav />}
        />

        <Card className="p-5">
          <div className="mb-4">
            <Segmented
              value={mode}
              onChange={(v) => setMode(v)}
              options={[
                { value: "url", label: "网页链接" },
                { value: "text", label: "粘贴正文" },
              ]}
            />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={mode}
              variants={gridItemVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="grid gap-3"
            >
              {mode === "url" ? (
                <Field
                  label="链接"
                  hint="只抓当前这一页，不会顺着站内链接扩展。遇到需要登录或反爬的站点，改用「粘贴正文」。"
                >
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://www.hello-algo.com/chapter_backtracking/backtracking_algorithm/"
                  />
                </Field>
              ) : (
                <Field label="正文" hint="至少 50 字。适合 PDF 复制出来的内容或内网文档。">
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    className="min-h-32"
                    placeholder="把要学的内容贴进来……"
                  />
                </Field>
              )}
              <Field label="标题（可选）">
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="不填就自动取"
                />
              </Field>
            </motion.div>
          </AnimatePresence>

          <div className="mt-4 flex items-center justify-end gap-3">
            {importMut.isPending ? (
              <span className="text-[12.5px] text-muted">
                正在抓取、分块、提炼知识点，长文可能要十几秒……
              </span>
            ) : null}
            <Button
              variant="brand"
              disabled={!canSubmit || importMut.isPending}
              onClick={() => importMut.mutate()}
            >
              {importMut.isPending ? <Spinner className="text-white" /> : null}
              导入并整理
            </Button>
          </div>

          <AnimatePresence>
            {importMut.isError ? (
              <motion.div
                variants={listItemVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="mt-3 flex items-start gap-2.5 overflow-hidden rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-3 text-[12.5px] text-danger"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {importMut.error instanceof Error ? importMut.error.message : "导入失败"}
                  {mode === "url" ? "。可以切到「粘贴正文」把内容直接贴进来。" : ""}
                </span>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </Card>

        {sources.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : sources.data?.length ? (
          <div className="grid gap-2">
            <AnimatePresence initial={false}>
              {sources.data.map((s) => (
                <motion.div
                  key={s.id}
                  layout
                  variants={listItemVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                >
                  <Card className="overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-3.5">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
                        {s.kind === "url" ? (
                          <Link2 className="h-4 w-4" />
                        ) : (
                          <FileText className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-medium">{s.title}</p>
                        <p className="truncate font-mono text-[11px] text-subtle">{s.originRef}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {s.parseQuality === "partial" ? (
                          <Badge tone="warning">正文可能不完整</Badge>
                        ) : null}
                        <Badge tone={s.unitCount > 0 ? "brand" : "neutral"}>
                          {s.unitCount} 个知识点
                        </Badge>
                        <span className="whitespace-nowrap text-[11.5px] tabular-nums text-subtle">
                          {s.blockCount} 块 · {(s.charCount / 1000).toFixed(1)}k 字
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="展开知识点"
                          onClick={() => setOpenId(openId === s.id ? null : s.id)}
                        >
                          <motion.span animate={{ rotate: openId === s.id ? 180 : 0 }}>
                            <ChevronDown className="h-4 w-4" />
                          </motion.span>
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="删除资料"
                          disabled={del.isPending}
                          onClick={() => del.mutate(s.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <AnimatePresence initial={false}>
                      {openId === s.id ? <UnitList key="units" sourceId={s.id} /> : null}
                    </AnimatePresence>
                  </Card>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <EmptyState
            icon={<BookOpen className="h-8 w-8" />}
            title="资料库还是空的"
            description="贴一个链接试试，比如 hello-algo.com 的回溯算法章节。导入后每个知识点都能点回原文出处。"
          />
        )}
      </div>
    </div>
  );
}

/** 某份资料提炼出的知识点，每条都显示它所依据的原文片段。 */
function UnitList({ sourceId }: { sourceId: string }) {
  const units = useQuery({
    queryKey: ["source-units", sourceId],
    queryFn: () => api.sourceUnits(sourceId),
  });

  return (
    <motion.div
      variants={listItemVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="overflow-hidden border-t bg-surface-2/40"
    >
      <div className="px-4 py-3">
        {units.isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : units.data?.length ? (
          <ol className="grid gap-2">
            {units.data.map((u, i) => (
              <li key={u.id} className="rounded-xl border bg-surface px-3.5 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-subtle">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <p className="text-[13.5px] font-medium">{u.title}</p>
                </div>
                <p className="mt-1 pl-6 text-[12.5px] leading-relaxed text-muted">{u.summary}</p>
                <details className="group mt-2 pl-6">
                  <summary className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-subtle hover:text-fg">
                    <Quote className="h-3 w-3" />
                    看原文出处
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap rounded-lg border-l-2 border-brand/50 bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-muted">
                    {u.sourceText || "（原文块已不存在）"}
                  </p>
                </details>
              </li>
            ))}
          </ol>
        ) : (
          <p className={cn("py-3 text-center text-[12.5px] text-subtle")}>
            这份资料还没有提炼出知识点。常见原因是导入时没有可用的模型——配置好模型后重新导入即可。
          </p>
        )}
      </div>
    </motion.div>
  );
}
