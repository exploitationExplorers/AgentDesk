import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/** 把弹出层挂到 body，按可用空间贴在锚点上方或下方，避免被聊天区 / 视口裁切。 */
export function AnchoredPortal({
  open,
  anchorRef,
  width,
  gap = 12,
  zIndex = 80,
  /** 默认裁切到可用高度；玻璃文件夹等需要溢出可见时设为 false。 */
  clip = true,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  width?: number | string;
  gap?: number;
  zIndex?: number;
  clip?: boolean;
  children: ReactNode;
}) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const maxWidth =
        typeof width === "number" ? width : Math.min(rect.width || 352, window.innerWidth - 32);
      const left = Math.min(Math.max(16, rect.left), window.innerWidth - maxWidth - 16);
      const spaceAbove = Math.max(0, rect.top - 16);
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 16);
      const placeAbove = spaceAbove >= 220 || spaceAbove >= spaceBelow;
      const available = Math.max(160, (placeAbove ? spaceAbove : spaceBelow) - gap);
      if (!clip) {
        // 玻璃文件夹需要溢出可见：按预估高度夹在视口内，避免贴底后顶部被裁掉。
        const dialogHeight = Math.min(460, window.innerHeight - 32);
        let top = placeAbove ? rect.top - gap - dialogHeight : rect.bottom + gap;
        top = Math.min(Math.max(16, top), Math.max(16, window.innerHeight - 16 - dialogHeight));
        setStyle({
          position: "fixed",
          left,
          top,
          width: typeof width === "number" ? width : maxWidth,
          maxWidth: "calc(100vw - 32px)",
          zIndex,
          overflow: "visible",
        });
        return;
      }
      setStyle({
        position: "fixed",
        left,
        width: typeof width === "number" ? width : maxWidth,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: available,
        zIndex,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        ...(placeAbove
          ? { bottom: Math.max(16, window.innerHeight - rect.top + gap) }
          : { top: Math.max(16, rect.bottom + gap) }),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, width, gap, zIndex, clip]);

  if (!open || !style || typeof document === "undefined") return null;
  return createPortal(
    <div data-anchored-portal className="min-h-0" style={style}>
      {children}
    </div>,
    document.body,
  );
}
