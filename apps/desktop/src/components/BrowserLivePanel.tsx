import { useMutation } from "@tanstack/react-query";
import { ExternalLink, MonitorSmartphone, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { BrowserSessionEvent, BrowserSessionState } from "@agentdesk/shared";
import { Button, cn } from "@agentdesk/ui";
import { api } from "../lib/api";
import { apiUrl } from "../lib/http";
import { subscribe } from "../lib/http";
import { useUi } from "../stores/ui";

/** Playwright 会话实况：截图流 + URL，可弹出有头窗口接管 */
export function BrowserLivePanel({
  sessionId,
  className,
  compact,
}: {
  sessionId: string;
  className?: string;
  compact?: boolean;
}) {
  const closeBrowserPanel = useUi((s) => s.closeBrowserPanel);
  const [session, setSession] = useState<BrowserSessionState | null>(null);
  const [shotSrc, setShotSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void api
      .browserSession(sessionId)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });

    let unsub = () => {};
    try {
      unsub = subscribe<BrowserSessionEvent>(
        `/browser/sessions/${encodeURIComponent(sessionId)}/events`,
        (e) => {
          if (e.type === "session") setSession(e.session);
          if (e.type === "frame") {
            setSession((prev) =>
              prev
                ? {
                    ...prev,
                    url: e.url,
                    title: e.title,
                    lastShotUrl: e.shotUrl,
                    updatedAt: new Date().toISOString(),
                  }
                : prev,
            );
          }
          if (e.type === "closed") {
            setSession((prev) => (prev ? { ...prev, open: false } : prev));
          }
        },
        { isFinal: (e) => e.type === "closed" },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => {
      cancelled = true;
      try {
        unsub();
      } catch {
        /* ignore */
      }
    };
  }, [sessionId]);

  useEffect(() => {
    const path = session?.lastShotUrl;
    if (!path) return;
    const revoked: string | null = null;
    void apiUrl(path.replace(/^\/api/, "")).then((u) => {
      setShotSrc(u);
    });
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [session?.lastShotUrl, session?.updatedAt]);

  const reveal = useMutation({
    mutationFn: () => api.browserReveal(sessionId),
    onSuccess: (s) => setSession(s),
  });

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col border-l bg-surface/40",
        compact ? "w-full" : "w-[380px] shrink-0",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <MonitorSmartphone className="h-3.5 w-3.5 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold">浏览器实况</p>
          <p className="truncate font-mono text-[10.5px] text-subtle">{sessionId}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          loading={reveal.isPending}
          onClick={() => reveal.mutate()}
          title="有头弹出系统浏览器"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          接管
        </Button>
        {!compact ? (
          <Button size="icon" variant="ghost" onClick={closeBrowserPanel} aria-label="关闭面板">
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="border-b px-3 py-2">
        <p className="truncate text-[12px] text-fg">{session?.title || "（无标题）"}</p>
        <p className="truncate font-mono text-[11px] text-muted">{session?.url || "…"}</p>
        <p className="mt-1 text-[10.5px] text-subtle">
          {session?.open === false
            ? "会话已关闭"
            : session?.headless === false
              ? "有头模式"
              : "无头 + 截图流"}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-black/40 p-2">
        {error ? (
          <p className="p-3 text-[12px] text-danger">{error}</p>
        ) : shotSrc ? (
          <img
            src={shotSrc}
            alt="browser live"
            className="w-full rounded-lg border border-white/10 object-contain"
          />
        ) : (
          <p className="p-6 text-center text-[12px] text-muted">等待截图…</p>
        )}
      </div>
    </div>
  );
}
