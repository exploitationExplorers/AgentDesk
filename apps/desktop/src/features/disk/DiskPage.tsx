import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Check,
  Code2,
  FileArchive,
  Folder,
  FolderOpen,
  Globe,
  Hand,
  HardDrive,
  Settings,
  Sparkles,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AppSettings,
  DiskCandidate,
  DiskCategory,
  DiskCleanRequest,
  DiskCleanCommitRequest,
  DiskCleanResult,
  DiskScan,
} from "@agentdesk/shared";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Segmented,
  cn,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { formatGB } from "../../lib/format";
import { useUi } from "../../stores/ui";
import { DiskUsageExplorer } from "./DiskUsageExplorer";

type OptionalFilter = "all" | "user" | "dev" | "system";

const OPTIONAL_FILTERS: Array<{ value: OptionalFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "user", label: "用户文件" },
  { value: "dev", label: "开发工具" },
  { value: "system", label: "系统" },
];

const CATEGORY_ICON: Record<DiskCategory, LucideIcon> = {
  browser: Globe,
  dev: Code2,
  app: AppWindow,
  ai: Sparkles,
  user: FileArchive,
  system: Trash2,
  other: Folder,
};

function optionalGroup(category: DiskCategory): Exclude<OptionalFilter, "all"> {
  if (category === "user") return "user";
  if (category === "dev" || category === "ai") return "dev";
  return "system";
}

function sumBytes(items: DiskCandidate[]): number {
  return items.reduce((total, item) => total + item.bytes, 0);
}

function scanClock(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DiskPage() {
  const queryClient = useQueryClient();
  const pendingDiskScan = useUi((s) => s.pendingDiskScan);
  const setPendingDiskScan = useUi((s) => s.setPendingDiskScan);
  const diskVolume = useUi((s) => s.diskVolume);
  const setDiskVolume = useUi((s) => s.setDiskVolume);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const status = useQuery({
    queryKey: ["disk-status"],
    queryFn: api.diskStatus,
    refetchInterval: 60_000,
  });
  const scan = useQuery({
    queryKey: ["disk-scan"],
    queryFn: api.diskScan,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const volumePath = diskVolume ?? status.data?.volumePath;
  const report = scan.data?.status.volumePath === volumePath ? scan.data : null;
  const used = status.data?.volumes.find((volume) => volume.volumePath === volumePath);
  const [threshold, setThreshold] = useState("15");
  const action = settings.data?.diskOptionalAction ?? "trash";
  const [draftAction, setDraftAction] = useState<AppSettings["diskOptionalAction"]>("trash");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [optionalFilter, setOptionalFilter] = useState<OptionalFilter>("all");
  const [selection, setSelection] = useState<{ scanId?: string; ids: Set<string> }>({
    ids: new Set(),
  });
  const [reviewed, setReviewed] = useState(false);
  const [keepOpen, setKeepOpen] = useState(false);
  const [receipt, setReceipt] = useState<DiskCleanResult | null>(null);
  const [usageRevision, setUsageRevision] = useState(0);
  const scanRequested = useRef(false);

  useEffect(() => {
    if (!diskVolume && status.data) setDiskVolume(status.data.volumePath);
  }, [diskVolume, status.data, setDiskVolume]);

  useEffect(() => {
    if (!settings.data) return;
    setThreshold(String(settings.data.diskThresholdGB));
    setDraftAction(settings.data.diskOptionalAction);
  }, [settings.data]);

  useEffect(() => {
    setSelection((previous) =>
      previous.scanId === report?.id
        ? previous
        : {
            scanId: report?.id,
            ids: new Set(
              (report?.items ?? [])
                .filter((item) => item.tier === "primary" && item.selectable)
                .map((item) => item.id),
            ),
          },
    );
  }, [report]);

  const runScan = useMutation({
    mutationFn: () => api.scanDisk(volumePath),
    onSuccess: (report) => {
      setReviewed(false);
      setReceipt(null);
      queryClient.setQueryData(["disk-scan"], report);
      void queryClient.invalidateQueries({ queryKey: ["disk-status"] });
    },
  });
  const review = useMutation({
    mutationFn: (report: DiskScan) => api.reviewDisk(report.id),
    onSuccess: (report) => {
      setReviewed(true);
      queryClient.setQueryData(["disk-scan"], report);
    },
  });
  const preview = useMutation({ mutationFn: (input: DiskCleanRequest) => api.planDisk(input) });
  const clean = useMutation({
    mutationFn: (input: DiskCleanCommitRequest) => api.cleanDisk(input),
    onSuccess: async (result) => {
      preview.reset();
      setReceipt(result);
      setUsageRevision((revision) => revision + 1);
      await queryClient.invalidateQueries({ queryKey: ["disk-scan"] });
      await queryClient.invalidateQueries({ queryKey: ["disk-status"] });
    },
  });
  const saveSettings = useMutation({
    mutationFn: () =>
      api.updateSettings({
        diskThresholdGB: Number(threshold),
        diskOptionalAction: draftAction,
      }),
    onSuccess: () => {
      setSettingsOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["disk-status"] });
    },
  });
  const reveal = useMutation({
    mutationFn: (id: string) => {
      if (!report) throw new Error("请先扫描所选磁盘");
      return api.revealDisk(report.id, id);
    },
  });

  useEffect(() => {
    if (!pendingDiskScan) {
      scanRequested.current = false;
      return;
    }
    if (scanRequested.current || !volumePath) return;
    scanRequested.current = true;
    setPendingDiskScan(false);
    runScan.mutate();
  }, [pendingDiskScan, setPendingDiskScan, runScan, volumePath]);

  const busy = runScan.isPending || review.isPending || clean.isPending || preview.isPending;
  const selected = selection.scanId === report?.id ? selection.ids : new Set<string>();
  const primary = report?.items.filter((item) => item.tier === "primary") ?? [];
  const optional = report?.items.filter((item) => item.tier === "optional") ?? [];
  const keep = report?.items.filter((item) => item.tier === "keep") ?? [];
  const visibleOptional = optional.filter(
    (item) => optionalFilter === "all" || optionalGroup(item.category) === optionalFilter,
  );
  const chosen = report?.items.filter((item) => selected.has(item.id) && item.selectable) ?? [];
  const chosenBytes = sumBytes(chosen);
  const releasedBytes = sumBytes(
    chosen.filter(
      (item) => item.tier === "primary" || item.mode === "recycle" || action === "delete",
    ),
  );
  const free = used?.freeBytes ?? 0;
  const total = used?.totalBytes ?? 0;
  const thresholdBytes = used?.thresholdBytes ?? 0;
  const after = Math.min(total, free + releasedBytes);
  const backAbove = thresholdBytes > 0 && after >= thresholdBytes;
  const thresholdNumber = Number(threshold);
  const canSave =
    Number.isFinite(thresholdNumber) && thresholdNumber >= 1 && thresholdNumber <= 2048;
  const error =
    status.error ??
    scan.error ??
    runScan.error ??
    review.error ??
    preview.error ??
    saveSettings.error;

  const toggle = (item: DiskCandidate) => {
    if (!item.selectable) return;
    setSelection((previous) => {
      const next = new Set(previous.scanId === report?.id ? previous.ids : []);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return { scanId: report?.id, ids: next };
    });
  };

  const setMany = (items: DiskCandidate[], on: boolean) => {
    setSelection((previous) => {
      const next = new Set(previous.scanId === report?.id ? previous.ids : []);
      for (const item of items) {
        if (!item.selectable) continue;
        if (on) next.add(item.id);
        else next.delete(item.id);
      }
      return { scanId: report?.id, ids: next };
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 pb-28 sm:px-8 sm:pt-8">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight">磁盘清理</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-subtle">
              {report ? `扫描于 ${scanClock(report.scannedAt)}` : "扫描只统计大小，确认后才清理"}
              {report ? (
                <Badge tone={reviewed ? "brand" : "neutral"}>
                  {reviewed ? "Bot 已复核" : "规则判断"}
                </Badge>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDraftAction(action);
                setSettingsOpen(true);
              }}
            >
              <Settings className="h-3.5 w-3.5" />
              设置
            </Button>
            <Button
              variant="secondary"
              disabled={!report || busy}
              loading={review.isPending}
              onClick={() => report && review.mutate(report)}
            >
              <Sparkles className="h-3.5 w-3.5" />让 Bot 复核
            </Button>
            <Button
              disabled={busy || !used}
              loading={runScan.isPending}
              onClick={() => runScan.mutate()}
            >
              {report ? "重新扫描" : "扫描"}
            </Button>
          </div>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="选择磁盘">
          {status.data?.volumes.map((volume) => (
            <button
              key={volume.volumePath}
              type="button"
              aria-pressed={volumePath === volume.volumePath}
              disabled={busy}
              onClick={() => {
                setDiskVolume(volume.volumePath);
                setReceipt(null);
                setReviewed(false);
                setKeepOpen(false);
                runScan.reset();
                review.reset();
                clean.reset();
                preview.reset();
              }}
              className={cn(
                "rounded-2xl border px-4 py-3 text-left transition-colors disabled:opacity-60",
                volumePath === volume.volumePath
                  ? "border-brand bg-brand/10"
                  : "bg-surface hover:bg-surface-2",
              )}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <HardDrive className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {volume.volumePath} {volume.label !== volume.volumePath ? volume.label : ""}
                </span>
                {volume.low ? <Badge tone="warning">空间不足</Badge> : null}
                {volume.volumePath === status.data?.volumePath ? (
                  <Badge tone="neutral">优先关注</Badge>
                ) : null}
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={cn("h-full rounded-full", volume.low ? "bg-danger" : "bg-brand")}
                  style={{
                    width: `${volume.totalBytes > 0 ? Math.min(100, (volume.usedBytes / volume.totalBytes) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="mt-2 text-[12px] text-subtle">
                剩余 {formatGB(volume.freeBytes)} / 共 {formatGB(volume.totalBytes)}
              </p>
            </button>
          ))}
        </div>
        {diskVolume && status.data && !used ? (
          <p className="mb-4 text-[12.5px] text-warning">
            所选磁盘已断开或不可读，请选择其他磁盘。
          </p>
        ) : null}
        <p className="mb-3 text-[12.5px] text-subtle">
          {volumePath ? `正在查看 ${volumePath}，扫描和清理仅针对这个磁盘。` : "正在检测本机磁盘…"}
        </p>

        <div className="grid items-stretch gap-3 lg:grid-cols-[210px_1fr_1fr_1fr]">
          <Card className="flex flex-col items-center justify-center px-4 py-5">
            <UsageRing
              total={total}
              free={free}
              selected={releasedBytes}
              threshold={thresholdBytes}
            />
            <div className="mt-1 text-center">
              <p className="text-[12px] text-subtle">当前剩余</p>
              <p
                className={cn(
                  "text-[26px] font-semibold tracking-tight",
                  used?.low ? "text-danger" : "text-fg",
                )}
              >
                {used ? formatGB(free) : "—"}
              </p>
              <p className="text-[11.5px] text-subtle">
                {used ? `共 ${formatGB(total)} · 阈值 ${formatGB(thresholdBytes)}` : "正在读取"}
              </p>
            </div>
            <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-subtle">
              <Legend swatch="bg-warning" label="已用" />
              <Legend swatch="bg-success" label="勾选后释放" />
              <Legend swatch="bg-fg" label="阈值" />
            </div>
          </Card>
          <Stat
            label="当前剩余"
            value={used ? formatGB(free) : "—"}
            hint={
              used?.low && thresholdBytes > free
                ? `低于阈值 ${formatGB(thresholdBytes - free)}`
                : "高于提醒阈值"
            }
            tone={used?.low ? "danger" : "default"}
          />
          <Stat
            label="预计立即释放"
            value={formatGB(releasedBytes)}
            hint={`已选 ${chosen.length} 项${action === "trash" ? " · 移入回收站暂不释放" : ""}`}
            tone="success"
          />
          <Stat
            label="清理后剩余"
            value={used ? formatGB(after) : "—"}
            hint={backAbove ? "回到阈值以上" : "仍低于阈值"}
            tone={backAbove ? "success" : "default"}
          />
        </div>

        {error ? <p className="mt-4 text-[12.5px] text-danger">{error.message}</p> : null}
        {receipt ? <CleanupReceipt result={receipt} /> : null}
        {used ? (
          <DiskUsageExplorer
            key={`${used.volumePath}:${report?.id ?? ""}:${usageRevision}`}
            volumePath={used.volumePath}
            volumeUsage={report?.usage}
            volumePartial={report?.partial}
            volumeStale={receipt !== null}
          />
        ) : null}

        {report ? (
          <div className="mt-4 grid gap-3">
            <div className="flex gap-3 rounded-2xl border border-brand/30 bg-brand/10 px-4 py-3">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
              <div>
                <p className="text-[13px] font-medium">{reviewed ? "Bot 分析" : "规则分析"}</p>
                <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{report.summary}</p>
              </div>
            </div>
            {backAbove ? (
              <div className="flex items-center gap-2 rounded-xl bg-success/15 px-4 py-2.5 text-[13px] text-success">
                <Check className="h-4 w-4" />
                按扫描估算，清理后剩余空间可回到 {formatGB(thresholdBytes)} 以上
              </div>
            ) : thresholdBytes > after ? (
              <div className="rounded-xl bg-warning/10 px-4 py-2.5 text-[13px] text-warning">
                还差 {formatGB(thresholdBytes - after)} 才能回到阈值
              </div>
            ) : null}

            <Section
              icon={<Check className="h-4 w-4" />}
              iconClass="bg-success/15 text-success"
              title={`首要清理 ${primary.length} 项`}
              description="可以自动重建的缓存，删除不会丢数据，已默认勾选"
              actionLabel={primary.some((item) => selected.has(item.id)) ? "全不选" : "全选"}
              onAction={() => setMany(primary, !primary.some((item) => selected.has(item.id)))}
              bytes={sumBytes(primary.filter((item) => selected.has(item.id)))}
            >
              <Rows
                items={primary}
                selected={selected}
                maxBytes={primary[0]?.bytes ?? 1}
                tone="primary"
                action={action}
                onToggle={toggle}
                onOpen={(id) => reveal.mutate(id)}
              />
            </Section>

            <Section
              icon={<Hand className="h-4 w-4" />}
              iconClass="bg-warning/15 text-warning"
              title={`需要你决定 ${optional.length} 项`}
              description="你的文件，或重新准备代价比较大的内容，只处理你勾选的"
              actionLabel={
                visibleOptional.every((item) => !item.selectable || selected.has(item.id))
                  ? "全不选"
                  : "全选"
              }
              onAction={() =>
                setMany(
                  visibleOptional,
                  visibleOptional.some((item) => item.selectable && !selected.has(item.id)),
                )
              }
              bytes={sumBytes(optional)}
            >
              <div className="flex gap-1 px-4 pb-2">
                {OPTIONAL_FILTERS.map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => setOptionalFilter(filter.value)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-[12px] font-medium",
                      optionalFilter === filter.value
                        ? "bg-surface-2 text-fg"
                        : "text-muted hover:text-fg",
                    )}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <Rows
                items={visibleOptional}
                selected={selected}
                maxBytes={visibleOptional[0]?.bytes ?? optional[0]?.bytes ?? 1}
                tone="optional"
                action={action}
                onToggle={toggle}
                onOpen={(id) => reveal.mutate(id)}
              />
            </Section>

            {keep.length ? (
              <button
                type="button"
                onClick={() => setKeepOpen((open) => !open)}
                className="px-1 text-left text-[12.5px] text-subtle hover:text-muted"
              >
                {keepOpen ? "收起" : "展开"}不会清理的 {keep.length} 项
              </button>
            ) : null}
            {keepOpen ? (
              <Rows
                items={keep}
                selected={selected}
                maxBytes={keep[0]?.bytes ?? 1}
                tone="keep"
                action={action}
                onToggle={toggle}
                onOpen={(id) => reveal.mutate(id)}
              />
            ) : null}
          </div>
        ) : (
          <EmptyState
            className="mt-6"
            title={scan.isLoading || runScan.isPending ? "正在扫描" : "还没有扫描"}
            description="扫描只统计大小。可重建缓存会直接删除，需要你决定的项默认进回收站。"
            action={
              <Button
                disabled={busy || !used}
                loading={runScan.isPending}
                onClick={() => runScan.mutate()}
              >
                开始扫描
              </Button>
            }
          />
        )}
      </div>

      <div className="sticky bottom-0 border-t bg-surface/95 px-4 py-3 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">
              已选 {chosen.length} 项 · {formatGB(chosenBytes)}
            </p>
            <p className="text-[12px] text-subtle">
              {action === "trash"
                ? "首要清理会直接删除；需要你决定的默认移到回收站"
                : "首要清理和需要你决定的都会直接删除"}
            </p>
            <div className="mt-2 h-1.5 max-w-sm overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn("h-full rounded-full", backAbove ? "bg-success" : "bg-warning")}
                style={{
                  width: `${thresholdBytes > 0 ? Math.min(100, (after / thresholdBytes) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="mt-1 text-[11.5px] text-subtle">
              {chosen.length > 200
                ? "每次最多确认 200 项，请缩小选择范围。"
                : backAbove
                  ? "按估算可回到阈值以上"
                  : "按估算仍低于阈值"}
            </p>
          </div>
          <Button
            variant="primary"
            disabled={!report || !used || chosen.length === 0 || chosen.length > 200 || busy}
            loading={preview.isPending}
            onClick={() => {
              if (!report) return;
              clean.reset();
              preview.mutate({ scanId: report.id, ids: chosen.map((item) => item.id) });
            }}
          >
            预览清理
          </Button>
        </div>
      </div>

      <Dialog
        open={!!preview.data}
        onOpenChange={(open) => {
          if (!open && !clean.isPending) preview.reset();
        }}
        title="确认清理清单"
        description={
          preview.data
            ? `${preview.data.volumePath} · 将处理 ${preview.data.items.length} 项`
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" disabled={clean.isPending} onClick={() => preview.reset()}>
              返回
            </Button>
            <Button
              variant={
                preview.data?.items.some((item) => item.action === "delete") ? "danger" : "primary"
              }
              loading={clean.isPending}
              disabled={
                !preview.data?.items.length ||
                !preview.variables ||
                clean.isPending ||
                report?.id !== preview.variables.scanId
              }
              onClick={() => {
                if (preview.data && preview.variables) {
                  clean.mutate({ ...preview.variables, planToken: preview.data.token });
                }
              }}
            >
              确认清理
            </Button>
          </>
        }
      >
        <ul className="divide-y divide-border">
          {preview.data?.items.map((item) => (
            <li key={item.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <b className="break-all">{item.title}</b>
                <Badge tone={item.action === "delete" ? "danger" : "neutral"}>
                  {item.mode === "recycle"
                    ? "清空回收站"
                    : item.action === "trash"
                      ? "移入回收站"
                      : item.mode === "contents"
                        ? "永久删除目录内容"
                        : "永久删除"}
                </Badge>
                <span className="ml-auto text-muted">{formatGB(item.bytes)}</span>
              </div>
              <p className="mt-1 break-all text-[12px] text-muted">{item.path}</p>
            </li>
          ))}
          {preview.data?.skipped.map((item) => (
            <li key={item.id} className="break-all py-2 text-[13px] text-warning">
              跳过 {item.path || item.id} · {item.reason}
            </li>
          ))}
        </ul>
        {preview.variables && report?.id !== preview.variables.scanId ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            扫描结果已更新，请返回重新预览。
          </p>
        ) : clean.error ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {clean.error.message}
          </p>
        ) : null}
      </Dialog>

      <Dialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="清理设置"
        description="阈值只用来提醒。可重建缓存始终直接删除。"
        footer={
          <Button
            disabled={!canSave || saveSettings.isPending}
            loading={saveSettings.isPending}
            onClick={() => saveSettings.mutate()}
          >
            保存
          </Button>
        }
      >
        <div className="grid gap-4">
          <Field label="提醒阈值（GB）">
            <Input
              type="number"
              min={1}
              max={2048}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
            />
          </Field>
          <Field label="需要你决定的项目">
            <Segmented
              value={draftAction}
              onChange={setDraftAction}
              options={[
                { value: "trash", label: "移到回收站" },
                { value: "delete", label: "直接删除" },
              ]}
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-1.5 w-1.5 rounded-full", swatch)} />
      {label}
    </span>
  );
}

function CleanupReceipt({ result }: { result: DiskCleanResult }) {
  const { freeBytesBefore, freeBytesAfter, cleaned, skipped } = result;
  const trashBytes = cleaned.reduce(
    (total, item) => total + (item.action === "trash" ? item.bytes : 0),
    0,
  );
  const delta =
    freeBytesBefore !== undefined && freeBytesAfter !== undefined
      ? freeBytesAfter - freeBytesBefore
      : undefined;
  return (
    <Card className="mt-4 px-4 py-4">
      <h2 className="text-[14px] font-semibold">清理结果</h2>
      <p role="status" className="mt-1 text-[13px] text-muted">
        已处理 {cleaned.length} 项 · 跳过 {skipped.length} 项
      </p>
      <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-3">
        <div>
          <dt className="text-muted">永久删除大小（估算）</dt>
          <dd>{formatGB(result.freedBytes)}</dd>
        </div>
        <div>
          <dt className="text-muted">移入回收站（估算）</dt>
          <dd>{formatGB(trashBytes)}</dd>
        </div>
        <div>
          <dt className="text-muted">磁盘可用空间变化</dt>
          <dd>
            {delta === undefined
              ? "未能测量"
              : `${delta < 0 ? "减少 " : delta > 0 ? "增加 " : ""}${formatGB(Math.abs(delta))}`}
          </dd>
        </div>
      </dl>
      {freeBytesBefore !== undefined && freeBytesAfter !== undefined ? (
        <p className="mt-2 text-[12px] text-muted">
          清理前 {formatGB(freeBytesBefore)} · 清理后 {formatGB(freeBytesAfter)}
          。两次读数也会反映期间其他程序的磁盘活动。
        </p>
      ) : null}
      {cleaned.some((item) => item.action === "trash") ? (
        <p className="mt-2 text-[12px] text-muted">移入回收站的文件需清空回收站后才释放空间。</p>
      ) : null}
      {skipped.length > 0 ? (
        <details className="mt-2 text-[13px] text-muted">
          <summary className="cursor-pointer">查看跳过原因</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {skipped.map((item) => (
              <li key={item.id} className="break-all">
                {item.path || item.id} · {item.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "default" | "danger" | "success";
}) {
  return (
    <Card className="flex flex-col justify-center px-4 py-4">
      <p className="text-[12px] text-subtle">{label}</p>
      <p
        className={cn(
          "mt-1 text-[22px] font-semibold tracking-tight",
          tone === "danger" && "text-danger",
          tone === "success" && "text-success",
        )}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[12px] text-subtle">{hint}</p>
    </Card>
  );
}

function UsageRing({
  total,
  free,
  selected,
  threshold,
}: {
  total: number;
  free: number;
  selected: number;
  threshold: number;
}) {
  const size = 132;
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;
  const usedRatio = total > 0 ? Math.min(1, Math.max(0, total - free) / total) : 0;
  const selectedRatio = total > 0 ? Math.min(usedRatio, selected / total) : 0;
  const thresholdRatio = total > 0 ? Math.min(1, Math.max(0, total - threshold) / total) : 0;
  const usedLen = length * usedRatio;
  const selectedLen = length * selectedRatio;
  const center = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        className="text-surface-2"
        stroke="currentColor"
        strokeWidth={stroke}
      />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        className="text-warning"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={`${usedLen} ${length - usedLen}`}
        transform={`rotate(-90 ${center} ${center})`}
      />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        className="text-success"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={`${selectedLen} ${length - selectedLen}`}
        strokeDashoffset={-(usedLen - selectedLen)}
        transform={`rotate(-90 ${center} ${center})`}
      />
      <circle
        cx={center}
        cy={stroke / 2 + 1}
        r={3.5}
        className="fill-fg"
        transform={`rotate(${thresholdRatio * 360} ${center} ${center})`}
      />
    </svg>
  );
}

function Section({
  icon,
  iconClass,
  title,
  description,
  actionLabel,
  onAction,
  bytes,
  children,
}: {
  icon: ReactNode;
  iconClass: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  bytes: number;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={cn("grid h-8 w-8 place-items-center rounded-xl", iconClass)}>{icon}</span>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold">{title}</p>
          <p className="text-[12px] text-subtle">{description}</p>
        </div>
        <button
          type="button"
          onClick={onAction}
          className="ml-auto text-[12.5px] font-medium text-brand"
        >
          {actionLabel}
        </button>
        <span className="text-[13px] font-medium">{formatGB(bytes)}</span>
      </div>
      {children}
    </Card>
  );
}

function Rows({
  items,
  selected,
  maxBytes,
  tone,
  action,
  onToggle,
  onOpen,
}: {
  items: DiskCandidate[];
  selected: Set<string>;
  maxBytes: number;
  tone: "primary" | "optional" | "keep";
  action: AppSettings["diskOptionalAction"];
  onToggle: (item: DiskCandidate) => void;
  onOpen: (id: string) => void;
}) {
  if (!items.length) {
    return <p className="px-4 pb-4 text-[12.5px] text-subtle">这一档没有项目</p>;
  }
  return (
    <div className="divide-y border-t">
      {items.map((item) => (
        <DiskRow
          key={item.id}
          item={item}
          checked={item.selectable && selected.has(item.id)}
          maxBytes={maxBytes}
          tone={tone}
          action={action}
          onToggle={() => onToggle(item)}
          onOpen={() => onOpen(item.id)}
        />
      ))}
    </div>
  );
}

function DiskRow({
  item,
  checked,
  maxBytes,
  tone,
  action,
  onToggle,
  onOpen,
}: {
  item: DiskCandidate;
  checked: boolean;
  maxBytes: number;
  tone: "primary" | "optional" | "keep";
  action: AppSettings["diskOptionalAction"];
  onToggle: () => void;
  onOpen: () => void;
}) {
  const Icon = CATEGORY_ICON[item.category];
  const width = maxBytes > 0 ? Math.max(12, Math.round((item.bytes / maxBytes) * 100)) : 0;
  const days = item.daysSinceUsed;
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 accent-[#3fb950]"
        disabled={!item.selectable}
        checked={checked}
        onChange={onToggle}
        aria-label={item.title}
      />
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-medium">{item.title}</span>
          {item.regenerable && tone === "primary" ? <Badge tone="success">可重建</Badge> : null}
          {days !== null && days >= 30 ? <Badge tone="danger">{days} 天未使用</Badge> : null}
          {days !== null && days < 30 ? <Badge>{days} 天未修改</Badge> : null}
          {tone === "optional" ? (
            <Badge tone="warning">
              {item.mode === "recycle"
                ? "清空所选盘回收站"
                : action === "trash"
                  ? "移到回收站"
                  : "直接删除"}
            </Badge>
          ) : null}
          {tone === "keep" ? <Badge>不清理</Badge> : null}
        </div>
        <p className="mt-0.5 text-[12.5px] leading-5 text-muted">{item.reason}</p>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11.5px] text-subtle">
          <span className="truncate font-mono">{item.path}</span>
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex shrink-0 items-center gap-1 hover:text-fg"
          >
            <FolderOpen className="h-3 w-3" />
            打开文件夹
          </button>
        </div>
      </div>
      <div className="w-24 shrink-0 text-right">
        <p className="text-[13px] font-medium">
          {formatGB(item.bytes)}
          {item.truncated ? "+" : ""}
        </p>
        <div className="mt-1.5 ml-auto h-1 w-16 overflow-hidden rounded-full bg-surface-2">
          <div
            className={cn("h-full rounded-full", tone === "optional" ? "bg-warning" : "bg-success")}
            style={{ width: `${width}%` }}
          />
        </div>
      </div>
    </div>
  );
}
