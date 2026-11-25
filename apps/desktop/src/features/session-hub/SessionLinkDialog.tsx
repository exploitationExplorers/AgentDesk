import { HubManualTool, hubManualToolNames, type HubWebEntry } from "@agentdesk/shared";
import { ChevronsUpDown } from "lucide-react";
import { useEffect, useId, useRef } from "react";

export function SessionLinkDialog({
  targetTitle,
  syncEnabled,
  busy,
  error,
  onClose,
  onSave,
}: {
  targetTitle?: string;
  syncEnabled: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (fields: HubWebEntry) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const prRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    prRef.current?.focus();
    return () => dialog?.close();
  }, []);
  function close() {
    if (busy) return;
    dialogRef.current?.close();
    onClose();
  }
  return (
    <dialog
      ref={dialogRef}
      className="vsh-link-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const { left, right, top, bottom } = e.currentTarget.getBoundingClientRect();
        if (e.clientX < left || e.clientX > right || e.clientY < top || e.clientY > bottom) close();
      }}
    >
      <header className="vsh-link-header">
        <h2 id={titleId}>{targetTitle === undefined ? "登记网页会话" : "编辑会话信息"}</h2>
        <button
          type="button"
          className="vsh-link-close"
          aria-label="关闭"
          onClick={close}
          disabled={busy}
        >
          ×
        </button>
      </header>
      <form
        className="vsh-link-form"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const value = (name: string) => data.get(name)?.toString().trim() || undefined;
          const pr = value("pr");
          const tool = HubManualTool.safeParse(value("tool"));
          onSave({
            pr: pr ? Number(pr) : undefined,
            title: value("title"),
            url: value("url"),
            note: value("note"),
            manualTool: tool.success ? tool.data : undefined,
          });
        }}
      >
        {targetTitle !== undefined && <p className="vsh-link-target">当前会话 · {targetTitle}</p>}
        <label>
          PR 编号（选填）
          <input
            ref={prRef}
            name="pr"
            inputMode="numeric"
            pattern="[0-9]{1,9}"
            maxLength={9}
            placeholder="例如 1234"
          />
        </label>
        {targetTitle === undefined && (
          <label>
            所属工具
            <span className="vsh-link-select">
              <select name="tool" defaultValue="gemini-web">
                {HubManualTool.options.map((tool) => (
                  <option key={tool} value={tool}>
                    {hubManualToolNames[tool]}
                  </option>
                ))}
              </select>
              <ChevronsUpDown aria-hidden size={14} />
            </span>
          </label>
        )}
        <label className="vsh-link-wide">
          会话链接（选填）
          <input name="url" type="url" maxLength={4096} placeholder="https://" />
        </label>
        <label className="vsh-link-wide">
          会话标题（选填）
          <input name="title" maxLength={300} placeholder="输入便于识别的标题" />
        </label>
        <label className="vsh-link-wide">
          可搜索的备注（选填）
          <textarea
            name="note"
            rows={2}
            maxLength={4000}
            placeholder="例如项目名、分支或待办事项"
          />
        </label>
        {error && (
          <p role="alert" className="vsh-link-error">
            {error}
          </p>
        )}
        <footer className="vsh-link-footer">
          {syncEnabled && <span>保存后同步到 iCloud</span>}
          <button type="button" className="vsh-btn vsh-btn-ghost" onClick={close} disabled={busy}>
            取消
          </button>
          <button type="submit" className="vsh-btn vsh-btn-primary" disabled={busy}>
            {busy ? "正在保存…" : "保存"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
