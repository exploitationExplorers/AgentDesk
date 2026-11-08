type HtmlInCanvasContext = CanvasRenderingContext2D & {
  drawElementImage: (element: Element, x: number, y: number) => DOMMatrix | void;
};

type HtmlInCanvasElement = HTMLCanvasElement & {
  updateElementGeometry?: (element: Element, options: { canvasTransform: DOMMatrix }) => void;
};

/** Configure the capture subtree for both generations of the experimental API. */
export function prepareHtmlInCanvas(source: HTMLCanvasElement, content: HTMLElement) {
  if ("content" in source) {
    source.setAttribute("content", "drawable");
    content.setAttribute("drawable", "");
  } else {
    source.setAttribute("layoutsubtree", "");
  }
}

/** Capture pixels and keep the native DOM hit-test region aligned with them. */
export function drawHtmlInCanvas(
  source: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  content: HTMLElement,
) {
  const transform = (context as HtmlInCanvasContext).drawElementImage(content, 0, 0);
  const canvas = source as HtmlInCanvasElement;
  // Chrome 154 decoupled geometry from drawing before enabling automatic 2D
  // synchronization. Older versions have no update method; newer versions
  // synchronize automatically and return void. Use the returned matrix as-is:
  // drawElementImage already accounts for the canvas's pixel density.
  if (transform && typeof canvas.updateElementGeometry === "function") {
    canvas.updateElementGeometry(content, { canvasTransform: transform });
  }
}

/** Shared computed-DOM capture for browsers without the experimental API. */
interface domSnapshotFallbackRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface domSnapshotFallbackPaintState {
  style: CSSStyleDeclaration;
  visible: boolean;
  opacity: number;
  clip: domSnapshotFallbackRect;
  childrenClip: domSnapshotFallbackRect;
}

function domSnapshotintersectFallbackRects(
  first: domSnapshotFallbackRect,
  second: domSnapshotFallbackRect,
): domSnapshotFallbackRect {
  return {
    left: Math.max(first.left, second.left),
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
  };
}

function domSnapshotpaintFallbackSnapshot(
  content: HTMLElement,
  canvas: HTMLCanvasElement,
  dpr: number,
) {
  const rootRect = content.getBoundingClientRect();
  const width = Math.max(1, Math.round(rootRect.width * dpr));
  const height = Math.max(1, Math.round(rootRect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is unavailable");
  ctx.resetTransform();
  ctx.clearRect(0, 0, width, height);
  ctx.scale(dpr, dpr);

  // 截图脱离页面合成树后，透明像素没有祖先背景；折射 shader 读取 RGB 会变黑。
  // 先合成祖先的底色，保留文本和图片的实际像素，避免用黑色填充透明区。
  const ancestors: Element[] = [];
  for (let ancestor = content.parentElement; ancestor; ancestor = ancestor.parentElement) {
    ancestors.unshift(ancestor);
  }
  for (const ancestor of ancestors) {
    ctx.fillStyle = getComputedStyle(ancestor).backgroundColor;
    ctx.fillRect(0, 0, rootRect.width, rootRect.height);
  }

  const rootClip: domSnapshotFallbackRect = {
    left: rootRect.left,
    top: rootRect.top,
    right: rootRect.right,
    bottom: rootRect.bottom,
  };
  const states = new WeakMap<Element, domSnapshotFallbackPaintState>();

  function resolveState(element: Element): domSnapshotFallbackPaintState {
    const cached = states.get(element);
    if (cached) return cached;

    const parent = element.parentElement;
    const parentState = parent && content.contains(parent) ? resolveState(parent) : null;
    const style = getComputedStyle(element);
    const ownOpacity = Number.parseFloat(style.opacity);
    const opacity = (parentState?.opacity ?? 1) * (Number.isFinite(ownOpacity) ? ownOpacity : 1);
    const visible =
      (parentState?.visible ?? true) &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      opacity > 0;
    const clip = parentState?.childrenClip ?? rootClip;
    const rect = element.getBoundingClientRect();
    const childrenClip = { ...clip };
    if (style.overflowX !== "visible") {
      childrenClip.left = Math.max(childrenClip.left, rect.left);
      childrenClip.right = Math.min(childrenClip.right, rect.right);
    }
    if (style.overflowY !== "visible") {
      childrenClip.top = Math.max(childrenClip.top, rect.top);
      childrenClip.bottom = Math.min(childrenClip.bottom, rect.bottom);
    }

    const state = { style, visible, opacity, clip, childrenClip };
    states.set(element, state);
    return state;
  }

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = walker.currentNode;
  while (current) {
    const element = current as HTMLElement;
    const rect = element.getBoundingClientRect();
    const state = resolveState(element);
    const visibleRect = domSnapshotintersectFallbackRects(rect, state.clip);
    if (
      state.visible &&
      visibleRect.right > visibleRect.left &&
      visibleRect.bottom > visibleRect.top
    ) {
      const { style } = state;
      ctx.save();
      ctx.beginPath();
      ctx.rect(
        state.clip.left - rootRect.left,
        state.clip.top - rootRect.top,
        state.clip.right - state.clip.left,
        state.clip.bottom - state.clip.top,
      );
      ctx.clip();
      ctx.globalAlpha = state.opacity;
      const x = rect.left - rootRect.left;
      const y = rect.top - rootRect.top;

      if (style.backgroundColor !== "transparent") {
        ctx.fillStyle = style.backgroundColor;
        ctx.fillRect(x, y, rect.width, rect.height);
      }

      domSnapshotpaintFallbackMedia(ctx, element, style, rect, rootRect);
      domSnapshotpaintFallbackText(ctx, element, style, rootRect);
      domSnapshotpaintFallbackBorders(ctx, style, rect, rootRect);
      ctx.restore();
    }
    current = walker.nextNode();
  }
  ctx.globalAlpha = 1;
}

function domSnapshotpaintFallbackMedia(
  ctx: CanvasRenderingContext2D,
  element: HTMLElement,
  style: CSSStyleDeclaration,
  rect: DOMRect,
  rootRect: DOMRect,
) {
  const drawable =
    element instanceof HTMLImageElement
      ? element.complete && element.naturalWidth > 0
        ? element
        : null
      : element instanceof HTMLCanvasElement
        ? element
        : element instanceof HTMLVideoElement && element.readyState >= 2
          ? element
          : null;
  if (!drawable) return;
  if (!domSnapshotisFallbackMediaOriginClean(drawable)) return;

  const sourceWidth =
    drawable instanceof HTMLImageElement
      ? drawable.naturalWidth
      : drawable instanceof HTMLVideoElement
        ? drawable.videoWidth
        : drawable.width;
  const sourceHeight =
    drawable instanceof HTMLImageElement
      ? drawable.naturalHeight
      : drawable instanceof HTMLVideoElement
        ? drawable.videoHeight
        : drawable.height;
  if (!(sourceWidth > 0 && sourceHeight > 0)) return;

  let sourceX = 0;
  let sourceY = 0;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let targetX = rect.left - rootRect.left;
  let targetY = rect.top - rootRect.top;
  let targetWidth = rect.width;
  let targetHeight = rect.height;
  const [positionX, positionY] = domSnapshotresolveObjectPosition(style.objectPosition);
  if (style.objectFit === "cover") {
    const scale = Math.max(rect.width / sourceWidth, rect.height / sourceHeight);
    cropWidth = rect.width / scale;
    cropHeight = rect.height / scale;
    sourceX = (sourceWidth - cropWidth) * positionX;
    sourceY = (sourceHeight - cropHeight) * positionY;
  } else if (style.objectFit === "contain" || style.objectFit === "scale-down") {
    const containScale = Math.min(
      rect.width / sourceWidth,
      rect.height / sourceHeight,
      style.objectFit === "scale-down" ? 1 : Number.POSITIVE_INFINITY,
    );
    targetWidth = sourceWidth * containScale;
    targetHeight = sourceHeight * containScale;
    targetX += (rect.width - targetWidth) * positionX;
    targetY += (rect.height - targetHeight) * positionY;
  }

  try {
    ctx.drawImage(
      drawable,
      sourceX,
      sourceY,
      cropWidth,
      cropHeight,
      targetX,
      targetY,
      targetWidth,
      targetHeight,
    );
  } catch (error) {
    console.warn("[Glass] Could not capture media frame", error);
  }
}

function domSnapshotisFallbackMediaOriginClean(
  drawable: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): boolean {
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  try {
    ctx.drawImage(drawable, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function domSnapshotresolveObjectPosition(position: string): [number, number] {
  const [x = "50%", y = "50%"] = position.split(/\s+/);
  return [
    domSnapshotresolvePositionValue(x, "left", "right"),
    domSnapshotresolvePositionValue(y, "top", "bottom"),
  ];
}

function domSnapshotresolvePositionValue(value: string, start: string, end: string): number {
  if (value === start) return 0;
  if (value === end) return 1;
  if (value === "center") return 0.5;
  if (value.endsWith("%")) {
    return Math.min(1, Math.max(0, Number.parseFloat(value) / 100));
  }
  return 0.5;
}

function domSnapshotpaintFallbackText(
  ctx: CanvasRenderingContext2D,
  element: HTMLElement,
  style: CSSStyleDeclaration,
  rootRect: DOMRect,
) {
  const textNodes = Array.from(element.childNodes).filter(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
  );
  if (textNodes.length === 0) return;

  ctx.fillStyle = style.color;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  ctx.textBaseline = "alphabetic";
  if ("letterSpacing" in ctx) {
    ctx.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
  }
  const textAlign: CanvasTextAlign =
    style.textAlign === "center" ||
    style.textAlign === "right" ||
    style.textAlign === "start" ||
    style.textAlign === "end"
      ? style.textAlign
      : "left";
  const direction: CanvasDirection = style.direction === "rtl" ? "rtl" : "ltr";
  ctx.textAlign = textAlign;
  ctx.direction = direction;

  const whiteSpace = style.whiteSpace;
  const preservesNewlines =
    whiteSpace === "pre" ||
    whiteSpace === "pre-wrap" ||
    whiteSpace === "pre-line" ||
    whiteSpace === "break-spaces";
  const preservesSpaces = preservesNewlines && whiteSpace !== "pre-line";

  const anchor =
    textAlign === "center"
      ? 0.5
      : textAlign === "right" ||
          (textAlign === "end" && direction === "ltr") ||
          (textAlign === "start" && direction === "rtl")
        ? 1
        : 0;

  function transform(text: string): string {
    if (style.textTransform === "uppercase") return text.toUpperCase();
    if (style.textTransform === "lowercase") return text.toLowerCase();
    return text;
  }

  function drawAcrossRects(text: string, rects: DOMRect[]) {
    const visible = rects.filter(
      (rect) =>
        rect.right > rootRect.left &&
        rect.left < rootRect.right &&
        rect.bottom > rootRect.top &&
        rect.top < rootRect.bottom,
    );
    if (visible.length === 0) return;
    const totalWidth = visible.reduce((sum, rect) => sum + rect.width, 0);
    let offset = 0;
    for (const [index, rect] of visible.entries()) {
      const remaining = text.length - offset;
      if (remaining <= 0) break;
      const count =
        index === visible.length - 1
          ? remaining
          : Math.min(remaining, Math.max(1, Math.round((text.length * rect.width) / totalWidth)));
      const slice = text.slice(offset, offset + count);
      offset += count;
      const line = preservesSpaces ? slice : slice.trim();
      if (!line.trim()) continue;
      const x = rect.left - rootRect.left + rect.width * anchor;
      const metrics = ctx.measureText(line);
      const ascent = metrics.fontBoundingBoxAscent ?? 0;
      const descent = metrics.fontBoundingBoxDescent ?? 0;
      const y =
        ascent > 0
          ? rect.top - rootRect.top + (rect.height - ascent - descent) / 2 + ascent
          : rect.bottom - rootRect.top - rect.height * 0.2;
      ctx.fillText(line, x, y, Math.max(rect.width, 1));
    }
  }

  for (const node of textNodes) {
    const raw = node.textContent ?? "";
    const range = document.createRange();

    if (preservesNewlines) {
      let position = 0;
      for (const part of raw.split("\n")) {
        const start = position;
        position += part.length + 1;
        if (!part.trim()) continue;
        range.setStart(node, start);
        range.setEnd(node, start + part.length);
        const text = transform(preservesSpaces ? part : part.replace(/\s+/g, " ").trim());
        drawAcrossRects(text, Array.from(range.getClientRects()));
      }
      continue;
    }

    const text = transform(raw.replace(/\s+/g, " ").trim());
    if (!text) continue;
    range.selectNodeContents(node);
    drawAcrossRects(text, Array.from(range.getClientRects()));
  }
}

function domSnapshotpaintFallbackBorders(
  ctx: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
  rect: DOMRect,
  rootRect: DOMRect,
) {
  const x = rect.left - rootRect.left;
  const y = rect.top - rootRect.top;
  const top = Number.parseFloat(style.borderTopWidth);
  const right = Number.parseFloat(style.borderRightWidth);
  const bottom = Number.parseFloat(style.borderBottomWidth);
  const left = Number.parseFloat(style.borderLeftWidth);
  if (top > 0) {
    ctx.fillStyle = style.borderTopColor;
    ctx.fillRect(x, y, rect.width, top);
  }
  if (right > 0) {
    ctx.fillStyle = style.borderRightColor;
    ctx.fillRect(x + rect.width - right, y, right, rect.height);
  }
  if (bottom > 0) {
    ctx.fillStyle = style.borderBottomColor;
    ctx.fillRect(x, y + rect.height - bottom, rect.width, bottom);
  }
  if (left > 0) {
    ctx.fillStyle = style.borderLeftColor;
    ctx.fillRect(x, y, left, rect.height);
  }
}

/**
 * Adapt only this source canvas, leaving native capability detection unchanged.
 * The original GPU shaders consume the captured text/images, including their
 * current scroll positions. Native HTML-in-Canvas remains the preferred path.
 */
export function createFallbackCapture(
  source: HTMLCanvasElement,
  content: HTMLElement,
  output: HTMLCanvasElement,
  forceSnapshot = false,
) {
  type CaptureCanvas = HTMLCanvasElement & {
    requestPaint?: () => void;
    onpaint?: (() => void) | null;
  };
  type CaptureContext = CanvasRenderingContext2D & {
    drawElementImage?: (element: Element, x: number, y: number) => DOMMatrix | void;
  };
  const context = source.getContext("2d") as CaptureContext | null;
  const canvas = source as CaptureCanvas;
  if (!context) return null;
  if (
    !forceSnapshot &&
    typeof context.drawElementImage === "function" &&
    typeof canvas.requestPaint === "function"
  ) {
    output.dataset.captureMode = "native";
    return null;
  }
  let timer = 0,
    stopped = false,
    last = 0;
  const request = () => {
    if (stopped || timer || document.hidden) return;
    timer = window.setTimeout(
      () => {
        timer = 0;
        if (stopped) return;
        last = performance.now();
        canvas.onpaint?.();
      },
      Math.max(0, 100 - (performance.now() - last)),
    );
  };
  const draw = () => {
    const dpr = output.width / Math.max(output.clientWidth, 1);
    context.reset();
    domSnapshotpaintFallbackSnapshot(content, source, Math.max(0.5, Math.min(dpr, 2)));
    output.dataset.captureCount = String(Number(output.dataset.captureCount ?? 0) + 1);
  };
  context.drawElementImage = draw;
  canvas.requestPaint = request;
  output.dataset.captureMode = "snapshot";
  const changes = new MutationObserver(request);
  changes.observe(content, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "src", "srcset", "hidden"],
  });
  changes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  const size = new ResizeObserver(request);
  size.observe(content);
  size.observe(output);
  const events = [
    "scroll",
    "load",
    "loadeddata",
    "input",
    "change",
    "transitionend",
    "animationend",
    "pointerover",
    "pointerout",
  ];
  events.forEach((event) =>
    content.addEventListener(event, request, { capture: true, passive: true }),
  );
  document.fonts?.addEventListener("loadingdone", request);
  document.addEventListener("visibilitychange", request);
  request();
  return {
    destroy() {
      stopped = true;
      window.clearTimeout(timer);
      changes.disconnect();
      size.disconnect();
      events.forEach((event) => content.removeEventListener(event, request, true));
      document.fonts?.removeEventListener("loadingdone", request);
      document.removeEventListener("visibilitychange", request);
      if (context.drawElementImage === draw) delete context.drawElementImage;
      if (canvas.requestPaint === request) delete canvas.requestPaint;
      delete output.dataset.captureMode;
      delete output.dataset.captureCount;
    },
  };
}
