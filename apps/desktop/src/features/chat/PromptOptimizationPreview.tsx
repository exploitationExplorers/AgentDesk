import { Check, Copy, RotateCcw, WandSparkles } from "lucide-react";
import { useState } from "react";
import { Button, Dialog } from "@agentdesk/ui";
import { toast } from "../../lib/toast";
import type { PromptOptimizationState } from "./usePromptOptimization";

export function PromptOptimizationPreview({
  state,
  open,
  canApply,
  onClose,
  onApply,
  onRetry,
}: {
  state: Extract<PromptOptimizationState, { status: "ready" }>;
  open: boolean;
  canApply: boolean;
  onClose: () => void;
  onApply: () => void;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.optimizedText);
      setCopied(true);
      toast("已复制优化结果", { tone: "success" });
    } catch {
      toast("复制失败，请选中结果手动复制", { tone: "danger" });
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        <span className="flex items-center gap-2">
          <WandSparkles className="h-4 w-4 text-brand" />
          优化提示词
        </span>
      }
      description="检查结果后再应用，应用后仍由你决定何时发送。"
      className="w-[min(720px,94vw)]"
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onRetry}>
            <RotateCcw className="h-3.5 w-3.5" />
            重新优化
          </Button>
          <Button size="sm" onClick={() => void copy()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </Button>
          <Button size="sm" variant="brand" disabled={!canApply} onClick={onApply}>
            应用到输入框
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {!canApply ? (
          <p
            role="status"
            className="rounded-xl border border-warning/20 bg-warning/5 p-3 text-xs leading-6 text-warning"
          >
            原文已修改，此结果不会覆盖当前草稿。你可以复制结果，或基于当前草稿重新优化。
          </p>
        ) : null}
        <div>
          <label htmlFor="optimized-prompt" className="mb-2 block text-xs font-medium text-fg">
            优化结果
          </label>
          <textarea
            id="optimized-prompt"
            aria-label="优化后的提示词"
            readOnly
            value={state.optimizedText}
            rows={10}
            className="max-h-[42vh] min-h-40 w-full resize-y rounded-xl border border-brand/15 bg-brand/3 p-3 text-[13px] leading-7 text-fg outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          />
        </div>
        <details className="rounded-xl border bg-surface/50 px-3 py-2">
          <summary className="cursor-pointer py-1 text-xs text-muted">查看原文</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words pt-2 font-sans text-xs leading-6 text-muted">
            {state.snapshot.sourceText}
          </pre>
        </details>
        <p className="flex flex-wrap justify-between gap-2 text-[11px] text-subtle">
          <span className="min-w-0 break-all">使用模型：{state.snapshot.model}</span>
          <span>请确认目标、代码和路径符合原意。</span>
        </p>
      </div>
    </Dialog>
  );
}
