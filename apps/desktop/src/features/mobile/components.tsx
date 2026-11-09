import { ArrowLeft, ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  children,
  busy,
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  variant?: "primary" | "secondary" | "danger" | "quiet";
}) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      disabled={props.disabled || busy}
      className={`m-button m-button-${variant} ${className}`}
    >
      {busy && <LoaderCircle size={17} className="m-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`m-notice${error ? " m-notice-error" : ""}`} role={error ? "alert" : "status"}>
      {children}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="m-empty">
      <span className="m-empty-mark">
        <ArrowUpRight size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Back({
  onClick,
  children = "返回",
}: {
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button className="m-back" onClick={onClick}>
      <ArrowLeft size={17} />
      {children}
    </button>
  );
}
export function Refresh({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button className="m-icon-button" aria-label="刷新" onClick={onClick} disabled={busy}>
      <RefreshCw size={18} className={busy ? "m-spin" : ""} />
    </button>
  );
}
const labels: Record<string, string> = {
  pending: "待执行",
  queued: "排队中",
  planning: "制定方案",
  awaiting_plan_approval: "等待方案审批",
  running: "执行中",
  awaiting_review: "等待验收",
  completed: "已完成",
  succeeded: "已成功",
  failed: "失败",
  cancelled: "已停止",
  closed: "已关闭",
  cancel_requested: "正在停止",
  online: "在线",
  offline: "离线",
  approved: "已批准",
  rejected: "已拒绝",
  expired: "已过期",
  accepted: "已受理",
  needs_reconciliation: "需要核对",
};
export function Status({ value }: { value: string }) {
  return <span className={`m-status m-status-${value}`}>{labels[value] ?? value}</span>;
}
