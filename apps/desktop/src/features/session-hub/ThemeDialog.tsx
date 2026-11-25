import { Check, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { themes } from "./themes";

export function ThemeDialog({
  selected,
  onSelect,
  onClose,
}: {
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="vsh-theme-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < box.left ||
          event.clientX > box.right ||
          event.clientY < box.top ||
          event.clientY > box.bottom
        )
          onClose();
      }}
    >
      <header className="vsh-theme-dialog-header">
        <div>
          <h2 id={titleId}>配色主题</h2>
          <p id={descriptionId}>选择配色，在会话中心实时预览效果。</p>
        </div>
        <button type="button" aria-label="关闭" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="vsh-theme-grid">
        {themes.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className="vsh-theme-card"
            aria-pressed={selected === theme.id}
            onClick={() => onSelect(theme.id)}
          >
            <span
              className="vsh-theme-preview"
              aria-hidden="true"
              style={{ background: theme.background, color: theme.previewText }}
            >
              <span className="vsh-theme-preview-sidebar">
                <span style={{ background: theme.accent }} />
              </span>
              <span className="vsh-theme-preview-content">
                <span />
                <span />
              </span>
            </span>
            <span className="vsh-theme-card-label">
              <strong>{theme.name}</strong>
              {selected === theme.id && <Check aria-hidden size={16} />}
            </span>
            <small>{theme.description}</small>
          </button>
        ))}
      </div>
      <footer className="vsh-theme-dialog-footer">
        <button type="button" className="vsh-btn vsh-btn-primary" onClick={onClose}>
          完成
        </button>
      </footer>
    </dialog>
  );
}
