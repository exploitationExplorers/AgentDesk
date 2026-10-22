import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { DiskStatus } from "@agentdesk/shared";
import { Button } from "@agentdesk/ui";
import { formatGB } from "../../lib/format";
import { useUi } from "../../stores/ui";
import { AppMark, useAppAvatar } from "../../components/AppMark";

const NAG_KEY = "agentdesk.diskNagUntil";
const NAG_MS = 6 * 60 * 60 * 1000;

function nagSilenced(): boolean {
  const until = Number(localStorage.getItem(NAG_KEY) || 0);
  return Number.isFinite(until) && Date.now() < until;
}

function silenceNag(): void {
  localStorage.setItem(NAG_KEY, String(Date.now() + NAG_MS));
}

/** 剩余空间低于阈值时的确认窗。关掉之后 6 小时内不再出现。 */
export function LowDiskDialog({ status }: { status: DiskStatus | undefined }) {
  const navigate = useNavigate();
  const avatar = useAppAvatar();
  const setPendingDiskScan = useUi((s) => s.setPendingDiskScan);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (status?.low && !nagSilenced()) setOpen(true);
  }, [status?.low]);

  if (!open || !status?.low) return null;

  const usedPct =
    status.totalBytes > 0
      ? Math.min(100, Math.round((status.usedBytes / status.totalBytes) * 100))
      : 0;

  const later = () => {
    silenceNag();
    setOpen(false);
  };
  const look = () => {
    silenceNag();
    setOpen(false);
    setPendingDiskScan(true);
    void navigate({ to: "/disk" });
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="disk-nag-title"
        className="w-[min(420px,92vw)] rounded-3xl border bg-elevated px-8 py-8 text-center shadow-2xl"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center overflow-hidden rounded-2xl bg-surface">
          <AppMark src={avatar} className="h-16 w-16" />
        </div>
        <h2 id="disk-nag-title" className="mt-5 text-[18px] font-semibold tracking-tight">
          磁盘只剩 {formatGB(status.freeBytes)} 了
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-6 text-muted">
          {`已经低于你定的 ${formatGB(status.thresholdBytes)}。要我帮你看看哪些能清掉吗？删哪些，你说了算。`}
        </p>
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-info" style={{ width: `${usedPct}%` }} />
        </div>
        <p className="mt-2 text-[12px] text-subtle">
          已用 {usedPct}% · 总容量 {formatGB(status.totalBytes)}
        </p>
        <div className="mt-6 flex gap-3">
          <Button className="flex-1" variant="secondary" onClick={later}>
            等会儿再说
          </Button>
          <Button className="flex-1" variant="brand" onClick={look}>
            帮我看看
          </Button>
        </div>
      </div>
    </div>
  );
}
