import {
  hubKey,
  hubManualToolNames,
  HubLinkFields,
  hubToolNames,
  parseHubPr,
  type HubSearchResult,
  type HubIndex,
  type HubSnapshot,
  type HubTool,
  type HubWebEntry,
  type HubRecord,
} from "@agentdesk/shared";
import { Button, Dialog } from "@agentdesk/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Bot, Globe, Laptop, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import logo from "./assets/logo.png";
import codex from "./assets/codex.png";
import cursor from "./assets/cursor.png";
import claude from "./assets/claude-desktop.png";
import gemini from "./assets/gemini.png";
import antigravity from "./assets/antigravity.png";
import grok from "./assets/grok-bot.png";
import { SessionLinkDialog } from "./SessionLinkDialog";
import { ThemeDialog } from "./ThemeDialog";
import { themes } from "./themes";
import { http } from "../../lib/http";
import { isTauri } from "../../lib/tauri";
import { toast } from "../../lib/toast";
import "./session-hub.css";

const icons: Partial<Record<HubTool, string>> = {
  codex,
  cursor,
  claude,
  gemini,
  "claude-desktop": claude,
  "gemini-desktop": gemini,
  antigravity,
  grok,
};
const cacheKey = ["session-hub"];
const themeKey = "agentdesk.session-hub.theme";
function ToolIcon({ tool, size }: { tool: HubTool; size: "xs" | "sm" | "md" | "btn" }) {
  const src = icons[tool];
  const className = `vsh-tool-logo vsh-tool-logo-${size}`;
  if (src) return <img alt="" src={src} className={className} />;
  const Icon = tool === "web" ? Globe : Bot;
  return <Icon aria-hidden className={className} />;
}
function sessionToolName(row: HubRecord) {
  return row.manualTool ? hubManualToolNames[row.manualTool] : hubToolNames[row.tool];
}
function ToolBadge({ row, large }: { row: HubRecord; large?: boolean }) {
  const tool =
    row.manualTool === "cursor" || row.manualTool === "gemini-desktop" ? row.manualTool : row.tool;
  return (
    <span className={`vsh-tool-tag ${large ? "vsh-tool-tag-lg" : ""}`}>
      <ToolIcon tool={tool} size={large ? "md" : "sm"} />
      {sessionToolName(row)}
    </span>
  );
}
function deviceLabel(device: HubSnapshot) {
  return device.deviceName.replace(/\.local$/i, "").replace(/^MacBook-Pro(?=-|$)/, "MacBook Pro");
}
function LocationTag({
  device,
  local,
  detailed,
}: {
  device: HubSnapshot;
  local: boolean;
  detailed?: boolean;
}) {
  return (
    <span className={`vsh-loc-badge ${local ? "vsh-loc-local" : "vsh-loc-remote"}`}>
      {detailed ? "💻 " : ""}
      {local ? "本机 · " : "远端 · "}
      {deviceLabel(device)}
    </span>
  );
}
function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`vsh-filter-pill ${active ? "vsh-active" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function date(time: number) {
  return time ? new Date(time).toLocaleString("zh-CN") : "未知";
}
function highlight(value: string, terms: string[]) {
  if (!terms.length) return value;
  const lower = value.toLowerCase();
  const parts: ReactNode[] = [];
  let start = 0;
  while (start < value.length) {
    let next = -1,
      length = 0;
    for (const term of terms) {
      const pos = lower.indexOf(term.toLowerCase(), start);
      if (pos >= 0 && (next === -1 || pos < next)) {
        next = pos;
        length = term.length;
      }
    }
    if (next === -1) break;
    parts.push(
      value.slice(start, next),
      <mark key={next}>{value.slice(next, next + length)}</mark>,
    );
    start = next + length;
  }
  return [...parts, value.slice(start)];
}
function relativeTime(time: number) {
  if (!time) return "";
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} 天前`;
  return new Date(time).toLocaleDateString("sv-SE");
}
function flatten(device: HubSnapshot) {
  return device.sessions.map((row) => ({ row, device, key: hubKey(device.deviceId, row) }));
}
type Item = ReturnType<typeof flatten>[number];
function contextText({ row, device }: Item) {
  return [
    row.title,
    `${sessionToolName(row)} · ${device.deviceName}`,
    row.directory,
    row.branch,
    row.prs.map((n) => `PR #${n}`).join(" · "),
    row.prompt,
    row.summary,
    row.note,
    row.url,
  ]
    .filter(Boolean)
    .join("\n\n");
}
async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  toast("已复制到剪贴板");
}
function exportFile(snapshot: HubSnapshot) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `agentdesk-sessions-${snapshot.deviceId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SessionHubPage() {
  const nav = useNavigate(),
    qc = useQueryClient();
  const search = useSearch({ from: "/session-hub" });
  const hub = useQuery({
    queryKey: cacheKey,
    queryFn: () => http.get<HubIndex>("/session-hub"),
    refetchInterval: 60000,
  });
  const [query, setQuery] = useState(""),
    [tool, setTool] = useState(""),
    [device, setDevice] = useState(""),
    [onlyPr, setOnlyPr] = useState(false),
    [selection, setSelection] = useState(search.session || ""),
    [limit, setLimit] = useState(80);
  const [dialog, setDialog] = useState<"web" | "pr" | "devices" | "theme" | null>(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  const [theme, setTheme] = useState<string>(() => {
    const saved = localStorage.getItem(themeKey);
    return themes.find((t) => t.id === saved)?.id ?? "prism-aurora";
  });
  const detailRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef<HTMLInputElement>(null),
    importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setSelection(search.session || "");
    setQuery("");
    setDevice("");
    setTool("");
    setOnlyPr(false);
  }, [search.session]);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        !dialog &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        queryRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focus, true);
    return () => window.removeEventListener("keydown", focus, true);
  }, [dialog]);
  const devices = useMemo(
    () => (hub.data ? [hub.data.local, ...hub.data.devices] : []),
    [hub.data],
  );
  const all = useMemo(
    () => devices.flatMap(flatten).sort((a, b) => b.row.updatedAt - a.row.updatedAt),
    [devices],
  );
  const pool = useMemo(
    () => (device ? all.filter((i) => i.device.deviceId === device) : all),
    [all, device],
  );
  const counts = useMemo(() => {
    const map = new Map<HubTool, number>();
    for (const { row } of pool) map.set(row.tool, (map.get(row.tool) || 0) + 1);
    return map;
  }, [pool]);
  const q = query.trim();
  const [settled, setSettled] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(q), 90);
    return () => clearTimeout(timer);
  }, [q]);
  const filters = { query: q, device, tool, onlyPr, limit: Math.min(limit, 1000) };
  const searchKey = [...cacheKey, "search", filters, hub.dataUpdatedAt];
  const results = useQuery({
    queryKey: searchKey,
    enabled: !!hub.data && !!q && settled === q,
    queryFn: ({ signal }) => http.post<HubSearchResult>("/session-hub/search", filters, { signal }),
    retry: false,
  });
  const pr = parseHubPr(q);
  const resolved = results.data?.resolved;
  const hits = useMemo(
    () => new Map(results.data?.hits.map((hit) => [hit.key, hit])),
    [results.data],
  );
  const filtered = useMemo(() => {
    if (!q)
      return pool.filter((i) => (!tool || tool === i.row.tool) && (!onlyPr || i.row.prs.length));
    const byKey = new Map(pool.map((i) => [i.key, i]));
    return [...hits.keys()].flatMap((key) => byKey.get(key) ?? []);
  }, [q, pool, tool, onlyPr, hits]);
  const filterMs = results.data?.elapsedMs ?? 0;
  const loading = hub.isPending || (!!q && results.isPending);
  const terms = pr ? [String(pr.number)] : q.split(/\s+/).filter(Boolean);
  const active = filtered.find((i) => i.key === selection) ?? filtered[0];
  useEffect(() => {
    detailRef.current?.scrollTo(0, 0);
  }, [active?.key]);
  const local = active?.device.deviceId === hub.data?.local.deviceId;
  const [binding, setBinding] = useState<{ key: string; title: string }>();
  function show(next: typeof dialog) {
    if (next === "pr" && active) setBinding({ key: active.key, title: active.row.title });
    setFormError("");
    setDialog(next);
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setFormError("");
    try {
      await action();
    } catch (e) {
      const message = e instanceof Error ? e.message : "操作失败";
      setFormError(message);
      toast(message, { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: cacheKey });
  };
  async function saveLink(fields: HubWebEntry) {
    await run(async () => {
      const validation = HubLinkFields.safeParse(fields);
      if (!validation.success) {
        if (fields.pr !== undefined && fields.pr < 1) throw new Error("PR 编号必须为正整数。");
        if (fields.url) throw new Error("请输入有效的 http 或 https 网页地址。");
        throw new Error("请至少填写一项会话信息。");
      }
      if (dialog === "pr" && binding) {
        await http.post("/session-hub/pr", { key: binding.key, ...validation.data });
      } else {
        const { key } = await http.post<{ key: string }>("/session-hub/web", fields);
        setSelection(key);
        setQuery("");
        setTool("");
        setDevice("");
        setOnlyPr(false);
      }
      await reload();
      show(null);
      toast("已保存");
    });
  }
  function jumpUrl(item: Item) {
    const url = new URL(window.location.href);
    url.hash = `/session-hub?${new URLSearchParams({ session: item.key })}`;
    return url.toString();
  }
  async function primary(item: Item) {
    const { row, key } = item;
    if (row.url) {
      if (isTauri()) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(row.url);
      } else window.open(row.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (row.tool === "web") {
      await copy(contextText(item));
      return;
    }
    if (item.device.deviceId !== hub.data?.local.deviceId) {
      await copy(key);
      return;
    }
    if (row.tool === "agentdesk") {
      await nav({ to: "/", search: { c: row.id } });
      return;
    }
    if (row.tool === "claude" || row.tool === "gemini") {
      if (!/^[\w-]+$/.test(row.id)) throw new Error("不支持此会话 ID");
      await copy(`${row.tool} --resume ${row.id}`);
      return;
    }
    await http.post("/session-hub/open", { key });
  }
  const primaryText = active?.row.url
    ? "打开网页会话"
    : active?.row.tool === "web"
      ? "复制上下文摘要"
      : active?.row.tool === "antigravity" && local
        ? "打开工作区"
        : !local
          ? "复制跨设备定位码"
          : active?.row.tool === "claude" || active?.row.tool === "gemini"
            ? "复制恢复命令"
            : `在 ${active ? sessionToolName(active.row) : ""} 中打开会话`;
  function keyboard(e: React.KeyboardEvent) {
    if (!active) return;
    const idx = filtered.indexOf(active);
    if (e.key === "Enter") {
      e.preventDefault();
      void run(() => primary(active));
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(
        filtered.length - 1,
        Math.max(0, idx + (e.key === "ArrowDown" ? 1 : -1)),
      );
      setSelection(filtered[next]!.key);
      setLimit((n) => Math.max(n, next + 1));
      requestAnimationFrame(() =>
        document
          .querySelector('.sh-result[aria-current="true"]')
          ?.scrollIntoView({ block: "nearest" }),
      );
    }
  }
  return (
    <section className="sh-page" data-hub-theme={theme} aria-label="会话中心">
      <header className="vsh-topbar">
        <div className="vsh-brand">
          <img className="vsh-brand-logo" alt="" src={logo} />
          <h1 className="vsh-brand-name">Vibe Session Hub</h1>
          <button className="vsh-machine-chip" title="设备索引" onClick={() => show("devices")}>
            <span className="vsh-status-dot" />
            <span className="vsh-machine-name">
              {hub.data ? `${deviceLabel(hub.data.local)} (本机)` : "读取中…"}
            </span>
          </button>
        </div>
        <div className="vsh-topbar-actions">
          <span className="vsh-sync-meta" role="status">
            {loading
              ? "正在搜索…"
              : `共匹配 ${Math.min(limit, filtered.length)} 条 · ${filterMs}ms`}
          </span>
          <span className="vsh-btn vsh-btn-ghost vsh-version" title="会话中心界面来源版本">
            ⓘ v1.0.4
          </span>
          <button className="vsh-btn vsh-btn-ghost" onClick={() => show("theme")}>
            <span className="vsh-theme-swatch-dot" />
            配色主题
          </button>
          <button className="vsh-btn vsh-btn-ghost" onClick={() => show("web")}>
            + 关联 PR / 网页会话
          </button>
          <button
            className="vsh-btn vsh-btn-secondary"
            disabled={busy || hub.isPending}
            onClick={() =>
              void run(async () => {
                qc.setQueryData(cacheKey, await http.post<HubIndex>("/session-hub/refresh"));
                toast("索引已更新");
              })
            }
          >
            同步索引
          </button>
        </div>
      </header>
      <div className="vsh-search-section">
        <div className="vsh-search-box">
          <Search className="vsh-search-icon" />
          <input
            className="vsh-search-input"
            ref={queryRef}
            maxLength={1024}
            type="search"
            autoComplete="off"
            spellCheck={false}
            aria-label="搜索会话"
            placeholder="输入 PR 编号（如 5590、#6306）、Git 分支名、报错或业务关键词…（⌘K 聚焦，↑↓ 选择，↵ 打开/复制）"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(80);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              else keyboard(e);
            }}
          />
          {query && (
            <button
              className="vsh-clear-btn"
              aria-label="清空搜索"
              onClick={() => {
                setQuery("");
                queryRef.current?.focus();
              }}
            >
              ✕
            </button>
          )}
        </div>
        <div className="vsh-filters-bar">
          <div className="vsh-pill-group">
            <FilterPill
              active={!device}
              onClick={() => {
                setDevice("");
                setTool("");
              }}
            >
              全部设备 ({all.length})
            </FilterPill>
            {devices.map((d) => (
              <FilterPill
                key={d.deviceId}
                active={device === d.deviceId}
                onClick={() => {
                  setDevice(d.deviceId);
                  setTool("");
                }}
              >
                💻 {deviceLabel(d)}
                {d === hub.data?.local ? " · 本机" : ""} ({d.sessions.length})
              </FilterPill>
            ))}
          </div>
          <span className="vsh-divider-v" />
          <div className="vsh-pill-group">
            <FilterPill active={!tool} onClick={() => setTool("")}>
              全部工具
            </FilterPill>
            {[...counts].map(([t, n]) => (
              <FilterPill key={t} active={tool === t} onClick={() => setTool(t)}>
                <ToolIcon tool={t} size="xs" />
                {hubToolNames[t]} ({n})
              </FilterPill>
            ))}
          </div>
          <label className="vsh-pr-toggle">
            <input type="checkbox" checked={onlyPr} onChange={(e) => setOnlyPr(e.target.checked)} />
            仅看含 PR (
            {pool.filter((i) => i.row.prs.length && (!tool || i.row.tool === tool)).length})
          </label>
        </div>
        {pr && (
          <div className="vsh-pr-banner">
            {resolved ? (
              <>
                <span>
                  <strong>PR #{pr.number}</strong> · {resolved.title}
                  {resolved.branch && (
                    <>
                      {" "}
                      · 分支 <code>{resolved.branch}</code>
                    </>
                  )}
                </span>
                {resolved.url && (
                  <a href={resolved.url} target="_blank" rel="noreferrer">
                    在 GitHub 查看 PR #{pr.number} ↗
                  </a>
                )}
              </>
            ) : (
              <>
                <span>
                  正在按 PR 编号搜索本地索引，若该 PR 当时在网页端手动创建，可拉取 GitHub
                  分支反查会话：
                </span>
                <button
                  className="vsh-btn vsh-btn-secondary"
                  disabled={busy || loading}
                  onClick={() =>
                    void run(async () => {
                      const data = await http.post<HubSearchResult>("/session-hub/search", {
                        ...filters,
                        remote: true,
                      });
                      qc.setQueryData(searchKey, data);
                    })
                  }
                >
                  {busy ? "正在查询…" : "联网反查 GitHub PR 分支"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {results.isError && (
        <div className="sh-notice" role="alert">
          {results.error.message} <button onClick={() => void results.refetch()}>重试</button>
        </div>
      )}
      {hub.data?.warnings.map((w) => (
        <div className="sh-notice" key={w}>
          {w}
        </div>
      ))}
      {search.session && hub.data && !all.some((i) => i.key === search.session) && (
        <div className="sh-notice">此索引中没有链接指向的会话。可从所属设备导入索引后再打开。</div>
      )}
      {hub.isError && (
        <div className="sh-notice" role="alert">
          {hub.error.message} <button onClick={() => void hub.refetch()}>重试</button>
        </div>
      )}
      <div className="vsh-workspace">
        <div className="vsh-results-list" aria-label="会话列表">
          {filtered.slice(0, limit).map((item) => (
            <button
              key={item.key}
              className={`vsh-result-item sh-result ${item.key === active?.key ? "vsh-selected" : ""}`}
              aria-current={item.key === active?.key}
              onClick={() => setSelection(item.key)}
              onKeyDown={keyboard}
            >
              <span className="vsh-item-top">
                <ToolBadge row={item.row} />
                <LocationTag device={item.device} local={item.device === hub.data?.local} />
                {item.row.prs.slice(0, 3).map((n) => (
                  <span key={n} className="vsh-pr-pill">
                    PR #{n}
                  </span>
                ))}
                <time className="vsh-item-time" title={date(item.row.updatedAt)}>
                  {relativeTime(item.row.updatedAt)}
                </time>
              </span>
              <span className="vsh-item-title">{highlight(item.row.title, terms)}</span>
              {(hits.get(item.key)?.snippet || item.row.prompt || item.row.summary) && (
                <span className="vsh-item-sub">
                  {highlight(
                    hits.get(item.key)?.snippet || item.row.prompt || item.row.summary,
                    terms,
                  )}
                </span>
              )}
              <span className="vsh-item-foot">
                {item.row.branch && <span className="vsh-mono-tag">🌿 {item.row.branch}</span>}
                {item.row.directory && (
                  <span className="vsh-mono-tag" title={item.row.directory}>
                    {item.row.directory.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")}
                  </span>
                )}
                {hits.get(item.key)?.reason && (
                  <span className="vsh-reason-tag">{hits.get(item.key)?.reason}</span>
                )}
              </span>
            </button>
          ))}
          {(q ? results.data?.hasMore && limit < 1000 : filtered.length > limit) && (
            <button className="vsh-btn vsh-btn-secondary" onClick={() => setLimit((n) => n + 80)}>
              显示更多会话
            </button>
          )}
          {!loading && !results.isError && !hub.isError && !filtered.length && (
            <p className="vsh-empty-list">
              {all.length
                ? "没有匹配的会话，试试其他关键词或筛选条件。"
                : "还没有会话。可以先关联网页会话，或使用编码工具后同步索引。"}
            </p>
          )}
        </div>
        <div className="vsh-detail-pane sh-detail" aria-label="会话详情" ref={detailRef}>
          {active ? (
            <article className="vsh-detail-card" key={active.key}>
              <div className="vsh-detail-header">
                <div className="vsh-detail-badges">
                  <ToolBadge row={active.row} large />
                  <LocationTag device={active.device} local={local} detailed />
                  {active.row.prs.map((n) => {
                    const url = active.row.prLinks?.find((link) => link.endsWith(`/pull/${n}`));
                    return url ? (
                      <a
                        className="vsh-pr-pill"
                        key={n}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PR #{n} ↗
                      </a>
                    ) : (
                      <span key={n} className="vsh-pr-pill">
                        PR #{n}
                      </span>
                    );
                  })}
                </div>
                <h2 className="vsh-detail-title">{highlight(active.row.title, terms)}</h2>
                <div className="vsh-action-bar">
                  <button
                    className="vsh-btn vsh-btn-primary vsh-btn-lg"
                    disabled={busy}
                    onClick={() => void run(() => primary(active))}
                  >
                    <ToolIcon tool={active.row.tool} size="btn" />
                    {primaryText} ↵
                  </button>
                  <button
                    className="vsh-btn vsh-btn-secondary"
                    onClick={() => void run(() => copy(jumpUrl(active)))}
                  >
                    复制跨机跳转链接
                  </button>
                  <button
                    className="vsh-btn vsh-btn-ghost"
                    onClick={() => void run(() => copy(contextText(active)))}
                  >
                    复制上下文摘要
                  </button>
                  {local && (
                    <button className="vsh-btn vsh-btn-ghost" onClick={() => show("pr")}>
                      + 绑定 PR 号
                    </button>
                  )}
                </div>
              </div>
              <dl className="vsh-meta-grid">
                {Object.entries({
                  "会话 ID": active.row.id,
                  "Git 分支": active.row.branch,
                  项目目录: active.row.directory,
                  最近活跃: date(active.row.updatedAt),
                  跨机链接: jumpUrl(active),
                  "关联 PR": active.row.prs.map((n) => `#${n}`).join("、"),
                  网页地址: active.row.url,
                })
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="vsh-meta-label">{k}</dt>
                      <dd className="vsh-meta-val">{v}</dd>
                    </Fragment>
                  ))}
              </dl>
              {[
                ["命中片段", hits.get(active.key)?.snippet || ""],
                ["初始提问", active.row.prompt],
                ["备注关键词", active.row.note],
                ["最新进展 / 回复摘要", active.row.summary],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <section className="vsh-section-block" key={k}>
                    <h3>{k}</h3>
                    <p className="vsh-text-box">{highlight(v || "", terms)}</p>
                  </section>
                ))}
            </article>
          ) : (
            <p className="vsh-empty-detail">选择左侧会话查看详情与跳转操作</p>
          )}
        </div>
      </div>
      {(dialog === "pr" || dialog === "web") && (
        <SessionLinkDialog
          targetTitle={dialog === "pr" ? binding?.title : undefined}
          syncEnabled={!!(hub.data?.cloud.enabled && hub.data.cloud.available)}
          busy={busy}
          error={formError}
          onSave={(fields) => void saveLink(fields)}
          onClose={() => show(null)}
        />
      )}
      {dialog === "theme" && (
        <ThemeDialog
          selected={theme}
          onSelect={(id) => {
            setTheme(id);
            localStorage.setItem(themeKey, id);
          }}
          onClose={() => show(null)}
        />
      )}
      <Dialog
        open={dialog === "devices"}
        onOpenChange={(v) => {
          if (!v) show(null);
        }}
        title="设备索引"
      >
        {dialog === "devices" ? (
          <div className="sh-form">
            <p>导出本机的会话标题、目录、PR 和上下文，或导入另一台设备导出的 AgentDesk 索引。</p>
            {(hub.data?.cloud.available || hub.data?.cloud.enabled) && (
              <label className="sh-cloud">
                <input
                  type="checkbox"
                  checked={hub.data.cloud.enabled}
                  disabled={busy}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    void run(async () => {
                      await http.post("/session-hub/cloud", { enabled });
                      await reload();
                    });
                  }}
                />
                <span>
                  通过 iCloud 云盘同步设备索引
                  <small>
                    开启后，会话中心会将上述信息写入 iCloud Drive / AgentDesk /
                    SessionHub。关闭后停止同步，已导出的文件会保留。
                  </small>
                </span>
              </label>
            )}
            {devices.map((d) => (
              <div key={d.deviceId} className="sh-device">
                <Laptop size={16} />
                {d.deviceName}
                <span>{d.sessions.length} 条</span>
              </div>
            ))}
            <div className="sh-actions">
              <Button disabled={!hub.data} onClick={() => hub.data && exportFile(hub.data.local)}>
                导出本机索引
              </Button>
              <Button disabled={busy} onClick={() => importRef.current?.click()}>
                导入设备索引
              </Button>
              <input
                ref={importRef}
                type="file"
                hidden
                accept=".json,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f)
                    void run(async () => {
                      if (f.size > 32 * 1024 * 1024) throw new Error("请选择小于 32 MB 的索引");
                      await http.post("/session-hub/import", JSON.parse(await f.text()));
                      await reload();
                      show(null);
                      toast("设备索引已导入");
                    });
                }}
              />
            </div>
          </div>
        ) : null}
        {formError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {formError}
          </p>
        )}
      </Dialog>
    </section>
  );
}
