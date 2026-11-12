import { useEffect, useRef, useState } from "react";
import {
  StoragePolicy,
  type CloudStorageStatus,
  type StorageCleanupPreview,
  type StorageCleanupResult,
} from "@agentdesk/shared";
import { cloudPath, errorMessage, type CloudApi, type CloudHost } from "../../lib/cloud-api";
import { Back, Button, Notice } from "./components";
import { displayTime, useCloudQuery, useOnline } from "./hooks";

const bytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
};
const fields = [
  ["screenshotDays", "旧截图保留天数", 1, 3650, 1],
  ["traceDays", "已关闭任务轨迹保留天数", 1, 3650, 1],
  ["eventDays", "已关闭任务事件保留天数", 1, 3650, 1],
  ["cacheLimitMiB", "截图缓存软上限（MiB）", 64, 1048576, 1],
  ["reserveGiB", "最小可用空间（GiB）", 1, 2048, 0.5],
  ["reservePercent", "分区空间预留（%）", 0, 25, 0.5],
] as const;

export function StorageView({
  api,
  host,
  isOwner,
  onBack,
}: {
  api: CloudApi;
  host: CloudHost | null;
  isOwner: boolean;
  onBack: () => void;
}) {
  const online = useOnline();
  const allowed = isOwner && host?.kind === "cloud" && host.capabilities.includes("storage.manage");
  const path = host ? cloudPath("hosts", host.id, "storage") : "";
  const query = useCloudQuery<CloudStorageStatus>(api, allowed ? path : null);
  const status = query.data?.hostId === host?.id ? query.data : undefined;
  const [form, setForm] = useState(() => StoragePolicy.parse({}));
  const [plan, setPlan] = useState<StorageCleanupPreview | null>(null);
  const [result, setResult] = useState<StorageCleanupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (status) {
      setForm(status.policy);
      setPlan(null);
    }
  }, [status]);
  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(
      () => {
        setPlan(null);
        setMessage("清理预览已过期，请重新预览。");
      },
      Math.max(0, Date.parse(plan.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [plan]);
  const dirty = Boolean(status && JSON.stringify(form) !== JSON.stringify(status.policy));
  const disabled =
    busy ||
    !online ||
    host?.status !== "online" ||
    !status ||
    query.loading ||
    !allowed ||
    Boolean(query.error);

  const act = async (kind: "save" | "preview" | "cleanup") => {
    if (disabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setMessage("");
    setResult(null);
    try {
      if (kind === "save") {
        const policy = StoragePolicy.parse(form);
        await api.request(`${path}/policy`, policy, "PUT", controller.signal);
        if (controller.signal.aborted) return;
        setPlan(null);
        setMessage("云宿主存储策略已保存。");
        query.refresh();
      } else if (kind === "preview") {
        setPlan(null);
        const next = await api.request<StorageCleanupPreview>(
          `${path}/cleanup/preview`,
          {},
          "POST",
          controller.signal,
        );
        if (!controller.signal.aborted) setPlan(next);
      } else if (plan) {
        const previewId = plan.id;
        // 预览只使用一次，连接失败也必须重新预览核对，不能盲重试删除。
        setPlan(null);
        const next = await api.request<StorageCleanupResult>(
          `${path}/cleanup`,
          { previewId },
          "POST",
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResult(next);
        query.refresh();
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(
          err instanceof Error && err.name === "ZodError"
            ? "请检查保留天数、缓存上限和磁盘预留范围。"
            : errorMessage(err),
        );
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const usage = status?.usage;
  return (
    <>
      <Back onClick={onBack} />
      <div className="m-form-title">
        <span className="m-overline">STORAGE · {host?.name}</span>
        <h2>云宿主存储</h2>
        <p>管理此服务器上的应用数据，电脑本地用量请在桌面设置查看。</p>
      </div>
      {!allowed ? (
        <Notice>仅云宿主 owner 可以管理服务器存储。旧版宿主需升级后使用。</Notice>
      ) : (
        <>
          {(error || query.error) && <Notice error>{error || query.error}</Notice>}
          {query.data && !status && <Notice error>宿主响应不匹配，请刷新后重试。</Notice>}
          {host?.status !== "online" && <Notice>宿主当前不在线，暂时无法管理存储。</Notice>}
          {message && <Notice>{message}</Notice>}
          {!online && <Notice>当前离线，已暂停刷新和写入。</Notice>}
          <section className="m-settings-group">
            <h3>服务器用量</h3>
            <Button
              variant="secondary"
              disabled={busy || query.loading || !online || host?.status !== "online"}
              onClick={() => query.refresh()}
            >
              刷新容量
            </Button>
            {query.loading && <p role="status">正在读取服务器容量…</p>}
            {usage && (
              <>
                <p style={{ overflowWrap: "anywhere" }}>{usage.dataDir}</p>
                <p>
                  已统计 {bytes(usage.totalBytes)}
                  {usage.incomplete ? "（部分数据，非完整总量）" : ""} ·{" "}
                  {displayTime(usage.measuredAt)}
                </p>
                {usage.disk && (
                  <p>
                    分区剩余 {bytes(usage.disk.freeBytes)} · 预留 {bytes(usage.disk.reserveBytes)}
                  </p>
                )}
                {usage.items.map((item) => (
                  <div className="m-device-card" key={item.name}>
                    <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      <strong>{item.name}</strong>
                      <small>
                        {item.protected ? "受保护" : "按留存规则检查"} · {bytes(item.bytes)}
                        {item.incomplete ? " + 未知部分" : ""}
                      </small>
                    </div>
                  </div>
                ))}
                {usage.warnings.map((warning) => (
                  <Notice key={warning}>{warning}</Notice>
                ))}
              </>
            )}
            <p>
              仅统计云 Runner 应用数据目录。工作区、Gateway 数据库、Docker、备份与外部工具缓存另计。
            </p>
          </section>
          <form
            className="m-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act("save");
            }}
          >
            <h3>留存与磁盘预留</h3>
            <label className="m-toggle">
              <input
                type="checkbox"
                checked={form.automaticCleanup}
                disabled={disabled}
                onChange={(event) => {
                  setForm({ ...form, automaticCleanup: event.target.checked });
                  setPlan(null);
                }}
              />
              <span>启用每小时自动清理</span>
            </label>
            <p>默认关闭。启用并保存后，仅回收已关闭任务的旧事件、轨迹与无引用旧截图。</p>
            {fields.map(([key, label, min, max, step]) => (
              <label key={key} className="m-field">
                <span>{label}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  step={step}
                  required
                  value={form[key]}
                  disabled={disabled}
                  onChange={(event) => {
                    setForm({ ...form, [key]: Number(event.target.value) });
                    setPlan(null);
                  }}
                />
              </label>
            ))}
            <p>
              空间预留取 GiB
              与分区百分比的较大值；截图软上限用于提示，不是全部数据配额。轨迹随满足更长留存条件的关闭任务回收。
            </p>
            <Button type="submit" disabled={disabled} busy={busy}>
              保存云宿主策略
            </Button>
          </form>
          <section className="m-settings-group">
            <h3>清理预览</h3>
            <p>
              不自动删除项目、原始正文、结果、产物、密钥或浏览器登录态。活跃任务、待审批与正在订阅的历史会跳过。数据库删行通常不会立即缩小主文件。
            </p>
            {dirty && <Notice>设置尚未保存，请先保存再预览。</Notice>}
            <Button
              variant="secondary"
              disabled={disabled || dirty}
              onClick={() => void act("preview")}
            >
              预览云宿主清理
            </Button>
            {plan && (
              <div role="status">
                <p>
                  旧截图 {plan.files} 个（{bytes(plan.fileBytes)}）、事件 {plan.events} 条、轨迹{" "}
                  {plan.traces} 条。
                </p>
                {plan.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
                <p>本预览仅适用于当前登录会话，5 分钟内有效；删除后无法撤销。</p>
                <Button
                  variant="danger"
                  disabled={
                    disabled ||
                    dirty ||
                    Date.parse(plan.expiresAt) <= Date.now() ||
                    plan.files + plan.events + plan.traces === 0
                  }
                  onClick={() => void act("cleanup")}
                >
                  执行云宿主本批清理
                </Button>
              </div>
            )}
            {result && (
              <Notice>
                已删除 {result.files} 个文件（{bytes(result.fileBytes)}）、{result.events} 条事件、
                {result.traces} 条轨迹，跳过 {result.skipped} 项。剩余内容可重新预览。
              </Notice>
            )}
          </section>
        </>
      )}
    </>
  );
}
