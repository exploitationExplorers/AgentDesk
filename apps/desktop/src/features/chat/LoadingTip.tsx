import { useEffect, useRef, useState } from "react";
import {
  LOADING_TIP_INITIAL_DELAY_MS,
  LOADING_TIP_ROTATION_MS,
  dismissLoadingTips,
  loadingTipsDismissed,
  pickNextTip,
  tipPool,
} from "./loading-tips";

/** WorkBuddy 同款：延迟出现 → 定时换句 → 可「不再显示」。 */
export function LoadingTip({ active }: { active: boolean }) {
  const [tip, setTip] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => loadingTipsDismissed());
  const paused = useRef(false);

  useEffect(() => {
    if (!active || hidden) {
      setTip(null);
      return;
    }
    const pool = tipPool();
    let rotateTimer: number | undefined;

    const rotate = () => {
      if (paused.current) return;
      setTip((current) => pickNextTip(pool, current));
    };

    const delayTimer = window.setTimeout(() => {
      rotate();
      rotateTimer = window.setInterval(rotate, LOADING_TIP_ROTATION_MS);
    }, LOADING_TIP_INITIAL_DELAY_MS);

    return () => {
      if (delayTimer) window.clearTimeout(delayTimer);
      if (rotateTimer) window.clearInterval(rotateTimer);
    };
  }, [active, hidden]);

  if (!active || hidden || !tip) return null;

  return (
    <span
      className="inline-flex max-w-full items-center gap-2 text-[13px] text-subtle"
      onMouseEnter={() => {
        paused.current = true;
      }}
      onMouseLeave={() => {
        paused.current = false;
      }}
    >
      <span aria-hidden="true" className="text-border">
        |
      </span>
      <span className="min-w-0 truncate">{tip}</span>
      <button
        type="button"
        className="shrink-0 text-[12px] text-subtle/80 hover:text-muted"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          dismissLoadingTips();
          setHidden(true);
          setTip(null);
        }}
      >
        不再显示
      </button>
    </span>
  );
}
