export type ToastTone = "success" | "danger" | "info" | "warning";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  createdAt: number;
}

type Listener = () => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export function getToasts(): ToastItem[] {
  return toasts;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** 页面内轻提示；默认 3.5s 后自动消失 */
export function toast(
  title: string,
  opts?: { description?: string; tone?: ToastTone; durationMs?: number },
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item: ToastItem = {
    id,
    title,
    description: opts?.description,
    tone: opts?.tone ?? "info",
    createdAt: Date.now(),
  };
  toasts = [...toasts, item].slice(-5);
  emit();
  const duration = opts?.durationMs ?? 3_500;
  if (duration > 0) {
    window.setTimeout(() => dismissToast(id), duration);
  }
  return id;
}
