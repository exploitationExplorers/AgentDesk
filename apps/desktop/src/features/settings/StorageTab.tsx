import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StoragePolicy, type StorageCleanupPreview } from "@agentdesk/shared";
import { Button, Card, Field, Input, Spinner } from "@agentdesk/ui";
import { api } from "../../lib/api";

const bytes = (value: number) =>
  value < 1024 ** 2
    ? `${(value / 1024).toFixed(1)} KiB`
    : value < 1024 ** 3
      ? `${(value / 1024 ** 2).toFixed(1)} MiB`
      : `${(value / 1024 ** 3).toFixed(2)} GiB`;

export function StorageTab() {
  const client = useQueryClient();
  const policy = useQuery({ queryKey: ["storage-policy"], queryFn: api.storagePolicy });
  const usage = useQuery({
    queryKey: ["storage-usage"],
    queryFn: api.storageUsage,
    staleTime: 30_000,
  });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const [form, setForm] = useState(StoragePolicy.parse({}));
  const [plan, setPlan] = useState<StorageCleanupPreview | null>(null);
  useEffect(() => {
    if (policy.data) setForm(policy.data);
  }, [policy.data]);
  const save = useMutation({
    mutationFn: () => api.updateStoragePolicy(StoragePolicy.parse(form)),
    onSuccess: (next) => {
      client.setQueryData(["storage-policy"], next);
      setPlan(null);
    },
  });
  const preview = useMutation({ mutationFn: api.previewStorageCleanup, onSuccess: setPlan });
  const cleanup = useMutation({
    mutationFn: (id: string) => api.cleanupStorage(id),
    onSettled: () => {
      setPlan(null);
      void client.invalidateQueries({ queryKey: ["storage-usage"] });
    },
  });
  const pending = save.isPending || preview.isPending || cleanup.isPending;
  const error = policy.error ?? usage.error ?? save.error ?? preview.error ?? cleanup.error;
  const numericFields = [
    ["screenshotDays", "旧截图保留天数", 1, 3650],
    ["traceDays", "已关闭任务轨迹保留天数", 1, 3650],
    ["eventDays", "已关闭任务事件保留天数", 1, 3650],
    ["cacheLimitMiB", "截图缓存软上限（MiB）", 64, 1048576],
    ["reserveGiB", "最小可用空间（GiB）", 1, 2048],
    ["reservePercent", "分区空间预留（%）", 0, 25],
  ] as const;

  return (
    <div className="grid min-w-0 max-w-4xl gap-5">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error.message}
        </p>
      ) : null}
      <Card className="grid gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">当前设备用量</h3>
          <Button
            variant="secondary"
            size="sm"
            loading={usage.isFetching}
            onClick={() => void usage.refetch()}
          >
            刷新统计
          </Button>
        </div>
        {usage.isPending ? <Spinner /> : null}
        {usage.data ? (
          <>
            <p className="break-all text-xs text-muted">{usage.data.dataDir}</p>
            <p className="text-sm">
              已统计 {bytes(usage.data.totalBytes)}
              {usage.data.incomplete ? "（部分数据，非完整总量）" : ""}
            </p>
            {usage.data.disk ? (
              <p className="text-xs text-muted">
                分区剩余 {bytes(usage.data.disk.freeBytes)} · 预留{" "}
                {bytes(usage.data.disk.reserveBytes)}，低于预留时暂停新任务与截图。
              </p>
            ) : null}
            <div className="divide-y divide-border/60">
              {usage.data.items.map((item) => (
                <div
                  key={item.name}
                  className="flex flex-wrap items-center justify-between gap-3 py-2 text-xs"
                >
                  <span className="min-w-0 break-all">
                    {item.name}{" "}
                    <span className="text-subtle">
                      {item.protected ? "受保护" : "按留存规则检查"}
                    </span>
                  </span>
                  <span>
                    {bytes(item.bytes)}
                    {item.incomplete ? " + 未知部分" : ""}
                  </span>
                </div>
              ))}
            </div>
            {usage.data.warnings.map((warning) => (
              <p key={warning} className="text-xs text-warning">
                {warning}
              </p>
            ))}
          </>
        ) : null}
        <p className="text-xs leading-6 text-subtle">
          仅统计应用数据目录，工作区、模型、外部工具缓存和服务器容量另计。统计不跟随链接；无法访问或超过扫描上限的内容显示为未知。
        </p>
      </Card>
      <Card className="grid gap-4 p-5">
        <h3 className="text-sm font-semibold">留存与磁盘预留</h3>
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 accent-brand"
            checked={form.automaticCleanup}
            disabled={pending || !policy.data}
            onChange={(event) => setForm({ ...form, automaticCleanup: event.target.checked })}
          />
          <span>
            启用每小时自动清理
            <span className="mt-1 block text-xs leading-6 text-muted">
              默认关闭。启用后仅回收已关闭任务的旧事件、聊天轨迹及无引用旧截图。
            </span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          {numericFields.map(([key, label, min, max]) => (
            <Field key={key} label={label}>
              <Input
                aria-label={label}
                type="number"
                min={min}
                max={max}
                step={key === "reserveGiB" || key === "reservePercent" ? "0.5" : "1"}
                value={form[key]}
                disabled={pending || !policy.data}
                onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })}
              />
            </Field>
          ))}
        </div>
        <p className="text-xs leading-6 text-muted">
          实际预留取 GiB
          与分区百分比中的较大值。软上限用于提示，不是个人数据总量上限；轨迹仅随已超过事件留存期的关闭任务回收。项目文件、产物、密钥与浏览器登录态不会自动删除。
        </p>
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={pending || !policy.data}
          onClick={() => save.mutate()}
        >
          保存存储策略
        </Button>
        {save.isSuccess ? (
          <p role="status" className="text-xs text-success">
            存储策略已保存
          </p>
        ) : null}
      </Card>
      <Card className="grid gap-4 p-5">
        <h3 className="text-sm font-semibold">清理预览</h3>
        <p className="text-xs leading-6 text-muted">
          使用已保存的策略。正在执行、待审批、有历史订阅或被引用的内容会跳过；旧事件回收后可继续查看任务结果与产物。删除数据库记录通常不会立即缩小主文件。
        </p>
        <Button
          variant="secondary"
          loading={preview.isPending}
          disabled={pending || !policy.data}
          onClick={() => preview.mutate()}
        >
          预览可清理内容
        </Button>
        {plan ? (
          <div className="grid gap-3 rounded-xl border border-border p-4 text-xs" role="status">
            <p>
              旧截图 {plan.files} 个，约 {bytes(plan.fileBytes)}；事件 {plan.events} 条；轨迹{" "}
              {plan.traces} 条。
            </p>
            {plan.warnings.map((warning) => (
              <p key={warning} className="text-muted">
                {warning}
              </p>
            ))}
            <Button
              variant="secondary"
              loading={cleanup.isPending}
              disabled={
                pending ||
                Date.parse(plan.expiresAt) <= Date.now() ||
                !(plan.files + plan.events + plan.traces)
              }
              onClick={() => cleanup.mutate(plan.id)}
            >
              执行本批清理
            </Button>
          </div>
        ) : null}
        {cleanup.data ? (
          <p role="status" className="text-xs text-success">
            已删除 {cleanup.data.files} 个文件（{bytes(cleanup.data.fileBytes)}）、
            {cleanup.data.events} 条事件、{cleanup.data.traces} 条轨迹；跳过 {cleanup.data.skipped}{" "}
            项。剩余内容可重新预览。
          </p>
        ) : null}
      </Card>
      <Card className="grid gap-3 p-5 text-xs leading-6 text-muted">
        <h3 className="text-sm font-semibold text-fg">个人凭证</h3>
        <p>
          个人 API Key
          保存在当前设备的加密存储，由本地模型请求使用。云端无人值守任务需要另外配置服务器服务凭证；本地设备离线时无法代为使用个人
          Key。
        </p>
        <p>
          主密钥保护方式：
          {health.data
            ? health.data.secretBackend === "keychain"
              ? "系统钥匙串或注入的主密钥"
              : "开发密钥文件（请勿与数据库一起作为普通同步文件上传）"
            : "正在读取"}
          。
        </p>
      </Card>
    </div>
  );
}
