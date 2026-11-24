import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, File, Folder } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { DiskDirectoryUsage, DiskUsageEntry } from "@agentdesk/shared";
import { Button, Card, Input } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { formatGB } from "../../lib/format";

interface Tile {
  entry: DiskUsageEntry;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 每次沿较长方向按大小分区，保留同级条目的面积比例。 */
function layout(entries: DiskUsageEntry[], x = 0, y = 0, width = 100, height = 100): Tile[] {
  if (entries.length === 0) return [];
  if (entries.length === 1) return [{ entry: entries[0]!, x, y, width, height }];
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let split = 1;
  let weight = entries[0]!.bytes;
  while (split < entries.length - 1 && weight + entries[split]!.bytes / 2 < total / 2) {
    weight += entries[split++]!.bytes;
  }
  const first = entries.slice(0, split);
  const second = entries.slice(split);
  if (width >= height) {
    const firstWidth = (width * weight) / total;
    return [
      ...layout(first, x, y, firstWidth, height),
      ...layout(second, x + firstWidth, y, width - firstWidth, height),
    ];
  }
  const firstHeight = (height * weight) / total;
  return [
    ...layout(first, x, y, width, firstHeight),
    ...layout(second, x, y + firstHeight, width, height - firstHeight),
  ];
}

export function DiskUsageExplorer({
  volumePath,
  volumeUsage,
  volumePartial,
  volumeStale,
}: {
  volumePath: string;
  volumeUsage?: DiskUsageEntry[];
  volumePartial?: boolean;
  volumeStale?: boolean;
}) {
  const [path, setPath] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [directory, setDirectory] = useState<DiskDirectoryUsage>();
  const inspect = useMutation({
    mutationFn: ({ target }: { target: string; history: string[] }) =>
      api.inspectDisk(volumePath, target),
    onSuccess: (result, input) => {
      setDirectory(result);
      setPath(result.path);
      setHistory(input.history);
    },
  });
  const current = directory?.path ?? volumePath;
  const usage = directory?.usage ?? volumeUsage ?? [];
  const tiles = layout(usage.filter((entry) => entry.bytes > 0).slice(0, 8));
  const navigate = (target: string) => {
    if (target.trim() && !inspect.isPending) {
      inspect.mutate({ target: target.trim(), history: [...history, current] });
    }
  };
  const openFolder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate(path);
  };

  return (
    <Card className="mt-4 px-4 py-4">
      <h2 className="text-[14px] font-semibold">主要空间占用</h2>
      <form onSubmit={openFolder} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 basis-48 space-y-1 text-[12px] text-muted">
          <span>当前磁盘内的文件夹</span>
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={volumePath}
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          disabled={!path.trim() || inspect.isPending}
          loading={inspect.isPending}
        >
          分析文件夹
        </Button>
      </form>
      {inspect.error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {inspect.error.message}
        </p>
      ) : null}
      {directory || volumeUsage ? (
        <>
          <div className="mt-4 flex items-center gap-2" aria-label="占用分析当前位置">
            {history.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={inspect.isPending}
                onClick={() => {
                  const parent = history.at(-1)!;
                  if (parent === volumePath) {
                    inspect.reset();
                    setDirectory(undefined);
                    setHistory([]);
                    setPath("");
                  } else {
                    inspect.mutate({ target: parent, history: history.slice(0, -1) });
                  }
                }}
              >
                <ArrowLeft size={14} />
                返回
              </Button>
            ) : null}
            <p className="min-w-0 break-all text-[13px] font-medium">{current}</p>
          </div>
          {directory?.git !== undefined ? (
            <p className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-fg">
              {directory.git === null
                ? "Git 仓库 · 无法核对工作区状态"
                : `Git 仓库 · ${directory.git.dirty ? "存在未提交变更" : "工作区无未提交变更"} · ${
                    directory.git.ahead === null
                      ? "未跟踪上游分支"
                      : directory.git.ahead > 0
                        ? `${directory.git.ahead} 个未推送提交`
                        : "没有领先上游的提交"
                  }`}
            </p>
          ) : null}
          {tiles.length > 0 ? (
            <>
              <p className="mt-2 text-[12px] text-muted">
                面积表示同级前 {tiles.length} 项的已统计大小。点击目录查看下一级。
              </p>
              <div
                aria-label="空间占用矩形图"
                role="group"
                className="relative mt-2 h-44 overflow-hidden rounded-xl bg-surface-2 sm:h-52"
              >
                {tiles.map(({ entry, x, y, width, height }) => {
                  const style = {
                    left: `${x}%`,
                    top: `${y}%`,
                    width: `${width}%`,
                    height: `${height}%`,
                  };
                  const label = `${entry.title} · ${entry.truncated ? "至少 " : ""}${formatGB(entry.bytes)}`;
                  const content =
                    width >= 15 && height >= 16 ? (
                      <span className="block truncate px-2 text-left text-[12px] font-medium">
                        {label}
                      </span>
                    ) : null;
                  return entry.kind === "directory" && width >= 15 && height >= 16 ? (
                    <button
                      key={entry.path}
                      type="button"
                      style={style}
                      title={label}
                      aria-label={`打开 ${label}`}
                      disabled={inspect.isPending}
                      onClick={() => navigate(entry.path)}
                      className="absolute overflow-hidden border border-surface bg-brand/20 text-fg hover:bg-brand/30 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-brand"
                    >
                      {content}
                    </button>
                  ) : (
                    <div
                      key={entry.path}
                      style={style}
                      title={label}
                      className="absolute flex items-center overflow-hidden border border-surface bg-info/15 text-fg"
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
          {(directory?.partial ?? volumePartial) ? (
            <p className="mt-2 text-[12px] text-warning">
              部分路径因权限、保护规则或扫描上限未统计。
            </p>
          ) : null}
          {!directory && volumeStale ? (
            <p className="mt-2 text-[12px] text-muted">
              此图来自清理前的扫描。重新扫描可更新占用。
            </p>
          ) : null}
          <ul
            aria-label="按大小排列的文件和目录"
            className="mt-2 max-h-64 divide-y divide-border overflow-y-auto"
          >
            {usage.map((entry) => {
              const label = `${entry.truncated ? "至少 " : ""}${formatGB(entry.bytes)}`;
              return (
                <li key={entry.path} className="text-[13px]">
                  {entry.kind === "directory" ? (
                    <button
                      type="button"
                      disabled={inspect.isPending}
                      onClick={() => navigate(entry.path)}
                      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand"
                    >
                      <Folder size={15} aria-hidden="true" className="shrink-0 text-brand" />
                      <span className="flex-1 break-all py-2">
                        {entry.title}
                        {entry.rebuildHint ? (
                          <span className="mt-0.5 block text-[12px] text-muted">
                            {entry.rebuildHint}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-muted">{label}</span>
                      <ChevronRight size={14} aria-hidden="true" className="shrink-0" />
                    </button>
                  ) : (
                    <div className="flex min-h-11 items-center gap-2 px-2">
                      <File size={15} aria-hidden="true" className="shrink-0 text-muted" />
                      <span className="flex-1 break-all">{entry.title}</span>
                      <span className="shrink-0 text-muted">{label}</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {usage.length === 0 ? (
            <p className="mt-3 text-[13px] text-muted">没有可显示的文件或目录。</p>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
