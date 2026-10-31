import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Box, Text, measureElement, useBoxMetrics, useInput, type DOMElement } from "ink";

/** 按终端行数裁剪实时内容，滚动只移动内容，不把整屏推入回滚区。 */
export default function ScrollViewport({
  children,
  maxRows,
  followEnd = true,
  arrows = false,
  focusedRef,
  focusKey,
}: {
  children: ReactNode;
  maxRows: number;
  followEnd?: boolean;
  arrows?: boolean;
  focusedRef?: RefObject<DOMElement | null>;
  focusKey?: string | null;
}) {
  const content = useRef<DOMElement>(null);
  const emptyRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(content);
  const focusedMetrics = useBoxMetrics(focusedRef ?? emptyRef);
  const [position, setPosition] = useState<number | null>(null);
  const available = Math.max(1, maxRows - 1);
  const height = metrics.hasMeasured ? Math.min(available, metrics.height) : available;
  const maxOffset = Math.max(0, metrics.height - height);
  const offset = position === null ? (followEnd ? maxOffset : 0) : Math.min(position, maxOffset);
  useEffect(() => {
    if (!focusKey || !focusedRef?.current || !content.current) return;
    const target = measureElement(focusedRef.current);
    const top = target.y - measureElement(content.current).y;
    setPosition((current) => {
      const previous = Math.min(current ?? (followEnd ? maxOffset : 0), maxOffset);
      if (top < previous || target.height >= height) return Math.min(top, maxOffset);
      if (top + target.height > previous + height)
        return Math.min(maxOffset, top + target.height - height);
      return current;
    });
  }, [focusKey, focusedRef, focusedMetrics, followEnd, maxOffset, height]);
  useEffect(() => {
    if (!focusKey) setPosition(null);
  }, [focusKey]);
  useInput((_input, key) => {
    const direction =
      key.pageUp || (arrows && key.upArrow)
        ? -1
        : key.pageDown || (arrows && key.downArrow)
          ? 1
          : 0;
    if (!direction) return;
    const distance = key.pageUp || key.pageDown ? Math.max(1, height - 1) : 1;
    const next = Math.max(0, Math.min(maxOffset, offset + direction * distance));
    setPosition(followEnd && next === maxOffset ? null : next);
  });
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        flexDirection="column"
        height={height}
        overflow="hidden"
        contentOffsetY={offset}
        flexShrink={0}
      >
        {/* 脱离视口的高度约束，否则短内容增长时 Yoga 会把新工具行压成零高度。 */}
        <Box ref={content} position="absolute" flexDirection="column" flexShrink={0} width="100%">
          {children}
        </Box>
      </Box>
      {maxOffset > 0 ? (
        <Text dimColor wrap="truncate-end">
          {`PgUp/PgDn 翻页 · ${offset + 1}–${Math.min(metrics.height, offset + height)}/${metrics.height} 行`}
        </Text>
      ) : null}
    </Box>
  );
}
