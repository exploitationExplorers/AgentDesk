import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "@agentdesk/ui";

/** 仅跟随底部读者；内容增高本身不能把“跟随”误判成用户离开底部。 */
export function useChatScroll(conversationId: string | undefined, active: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const reduced = useReducedMotion();
  const toBottom = useCallback(
    (smooth = true) => {
      following.current = true;
      setAway(false);
      const el = viewport.current;
      el?.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? "smooth" : "instant" });
    },
    [reduced],
  );

  // 兼容空会话首次发送时，滚动容器才挂载。
  useLayoutEffect(() => {
    const el = viewport.current;
    const body = content.current;
    if (!el || !body) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (following.current) el.scrollTop = el.scrollHeight;
      });
    };
    const observer = new ResizeObserver(follow);
    observer.observe(body);
    observer.observe(el);
    follow();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [conversationId, active]);

  useLayoutEffect(() => {
    toBottom(false);
  }, [conversationId, toBottom]);
  return {
    viewport,
    content,
    away,
    toBottom,
    onScroll: () => {
      const el = viewport.current;
      if (!el) return;
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
      following.current = near;
      setAway(!near);
    },
  };
}
