/** Shared native DOM lifecycle. No iframe, global IDs, or executable HTML. */
export interface MotionOptions {
  height?: number;
  reducedMotion?: boolean;
}
export interface MotionController {
  element: HTMLElement;
  root: ShadowRoot;
  update(options: MotionOptions): void;
  destroy(): void;
}
export interface SurfaceConfig {
  markup: string;
  css: string;
  width: number;
  height: number;
  responsive?: boolean;
}
const fonts = new Map<string, { face: FontFace; users: number }>();

export function createSurface(
  target: HTMLElement,
  config: SurfaceConfig,
  initial: MotionOptions = {},
) {
  let options = { ...initial };
  let destroyed = false;
  let scale = 1;
  const owner = target.ownerDocument;
  const browser = owner.defaultView!;
  const element = owner.createElement("div");
  element.dataset.motionSurface = "";
  element.style.cssText =
    "display:block;position:relative;width:100%;min-width:0;overflow:hidden;isolation:isolate;";
  target.appendChild(element);
  const root = element.attachShadow({ mode: "open" });
  const style = owner.createElement("style");
  style.textContent =
    `:host{display:block}[hidden]{display:none!important}*{box-sizing:border-box}.motion-frame{position:relative;transform-origin:top left;overflow:hidden}.motion-body{position:relative;width:100%;min-height:100%;margin:0}.motion-body>.leibox-otp.otp-stage{height:var(--motion-height)}.motion-body>.leibox-share.share-stage{min-height:var(--motion-height)}:host([data-reduced-motion=true]) *{animation-duration:0s!important;animation-iteration-count:1!important;transition-duration:0s!important}` +
    config.css
      .replace(/(^|[,\s}>+~])(?:html|body)(?=[\s,{.#:[>])/g, "$1.motion-body")
      .replace(/:root\b/g, ".motion-body")
      .replace(/100(?:s|d|l)?vh/g, "var(--motion-height)")
      .replace(/position\s*:\s*fixed/g, "position:absolute");
  const frame = owner.createElement("div");
  frame.className = "motion-frame";
  const body = owner.createElement("div");
  body.className = "motion-body";
  body.innerHTML = config.markup;
  frame.appendChild(body);
  root.append(style, frame);
  const frames = new Set<number>();
  const deferredFrames = new Set<FrameRequestCallback>();
  let painted = false;
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const observers = new Set<ResizeObserver | IntersectionObserver>();
  const cleanups: (() => void)[] = [];
  for (const rule of config.css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const definition = rule[1];
    if (!definition) continue;
    const name = definition.match(/font-family:\s*["']?([^;"']+)/)?.[1]?.trim();
    const source = definition.match(/src:\s*(url\([^)]*\))/)?.[1];
    if (!name || !source) continue;
    const key = `${name}:${source}`;
    let cached = fonts.get(key);
    if (!cached) {
      const face = new FontFace(name, source, { weight: "100 900" });
      owner.fonts.add(face);
      void face.load().catch(() => {});
      cached = { face, users: 0 };
      fonts.set(key, cached);
    }
    cached.users++;
    cleanups.push(() => {
      const entry = fonts.get(key);
      if (entry && --entry.users === 0) {
        owner.fonts.delete(entry.face);
        fonts.delete(key);
      }
    });
  }
  const ready: EventListenerOrEventListenerObject[] = [];
  const listeners: {
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
  }[] = [];
  const on = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    settings?: boolean | AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener, settings);
    listeners.push({ target, type, listener, options: settings });
  };
  const requestFrame: typeof requestAnimationFrame = (callback) => {
    if (destroyed) return 0;
    if (owner.hidden || (painted && reduced())) {
      deferredFrames.add(callback);
      return 0;
    }
    const id = browser.requestAnimationFrame((time) => {
      frames.delete(id);
      painted = true;
      if (!destroyed) callback(time);
    });
    frames.add(id);
    return id;
  };
  const cancelFrame = (id: number) => {
    browser.cancelAnimationFrame(id);
    frames.delete(id);
  };
  const timeout = (callback: () => void, ms?: number) => {
    const id = browser.setTimeout(() => {
      timeouts.delete(id);
      if (!destroyed) callback();
    }, ms);
    timeouts.add(id);
    return id;
  };
  const interval = (callback: () => void, ms?: number) => {
    const id = browser.setInterval(() => {
      if (!destroyed) callback();
    }, ms);
    intervals.add(id);
    return id;
  };
  const clearTimeout = (id: number) => {
    browser.clearTimeout(id);
    timeouts.delete(id);
  };
  const clearInterval = (id: number) => {
    browser.clearInterval(id);
    intervals.delete(id);
  };
  const query = (selector: string) =>
    selector === "body" || selector === "html" ? body : root.querySelector(selector);
  const document = new Proxy(owner, {
    get(original, key) {
      if (key === "body" || key === "documentElement") return body;
      if (key === "activeElement") return root.activeElement;
      if (key === "getElementById") return (id: string) => root.getElementById(id);
      if (key === "querySelector") return query;
      if (key === "querySelectorAll") return (selector: string) => root.querySelectorAll(selector);
      if (key === "addEventListener")
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          settings?: AddEventListenerOptions,
        ) => {
          if (type === "DOMContentLoaded") ready.push(listener);
          else on(owner, type, listener, settings);
        };
      if (key === "removeEventListener") return owner.removeEventListener.bind(owner);
      const value = Reflect.get(original, key, original);
      return typeof value === "function" ? value.bind(original) : value;
    },
  });
  const reduced = () =>
    options.reducedMotion ?? browser.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const resume = () => {
    if (!owner.hidden && !reduced()) {
      const callbacks = [...deferredFrames];
      deferredFrames.clear();
      callbacks.forEach(requestFrame);
    }
  };
  on(owner, "visibilitychange", resume);
  const matchMedia = (query: string) => {
    const media = browser.matchMedia(query);
    return new Proxy(media, {
      get(original, key) {
        if (key === "matches" && query.includes("prefers-reduced-motion")) return reduced();
        if (key === "addEventListener")
          return (type: string, listener: EventListener) => on(media, type, listener);
        const value = Reflect.get(original, key, original);
        return typeof value === "function" ? value.bind(original) : value;
      },
    });
  };
  const window = new Proxy(browser, {
    get(original, key) {
      if (key === "document") return document;
      if (key === "innerWidth") return frame.offsetWidth;
      if (key === "innerHeight") return config.height;
      if (key === "requestAnimationFrame") return requestFrame;
      if (key === "cancelAnimationFrame") return cancelFrame;
      if (key === "setTimeout") return timeout;
      if (key === "clearTimeout") return clearTimeout;
      if (key === "setInterval") return interval;
      if (key === "clearInterval") return clearInterval;
      if (key === "matchMedia") return matchMedia;
      if (key === "addEventListener")
        return (type: string, listener: EventListener, settings?: AddEventListenerOptions) =>
          on(browser, type, listener, settings);
      const value = Reflect.get(original, key, original);
      return typeof value === "function" ? value.bind(original) : value;
    },
  });
  const resize = () => {
    const available = element.clientWidth || config.width;
    scale = config.responsive ? 1 : Math.min(1, available / config.width);
    const height = options.height ?? config.height;
    element.style.setProperty("--motion-height", `${height}px`);
    frame.style.width = `${config.responsive ? available : Math.max(config.width, available)}px`;
    frame.style.height = config.responsive ? "auto" : `${height}px`;
    frame.style.minHeight = config.responsive ? `${height}px` : "0";
    frame.style.transform = `scale(${scale})`;
    body.style.minHeight = `${height}px`;
    element.style.height = config.responsive ? "auto" : `${height * scale}px`;
    element.dataset.reducedMotion = String(reduced());
  };
  const resizeObserver = new browser.ResizeObserver(resize);
  resizeObserver.observe(element);
  resize();
  const TrackedResizeObserver = class extends browser.ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      observers.add(this);
    }
  };
  const TrackedIntersectionObserver = class extends browser.IntersectionObserver {
    constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
      super(callback, init);
      observers.add(this);
    }
  };
  const controller: MotionController = {
    element,
    root,
    update(next) {
      if (destroyed) return;
      options = { ...options, ...next };
      resize();
      resume();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      frames.forEach((id) => browser.cancelAnimationFrame(id));
      timeouts.forEach((id) => browser.clearTimeout(id));
      intervals.forEach((id) => browser.clearInterval(id));
      resizeObserver.disconnect();
      observers.forEach((observer) => observer.disconnect());
      listeners.forEach(({ target, type, listener, options }) =>
        target.removeEventListener(type, listener, options),
      );
      cleanups.reverse().forEach((cleanup) => cleanup());
      root
        .querySelectorAll("dialog[open]")
        .forEach((dialog) => (dialog as HTMLDialogElement).close());
      element.remove();
      frames.clear();
      deferredFrames.clear();
      timeouts.clear();
      intervals.clear();
    },
  };
  return {
    ...controller,
    controller,
    body,
    frame,
    document,
    window,
    on,
    reduced,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    setTimeout: timeout,
    clearTimeout,
    setInterval: interval,
    clearInterval,
    ResizeObserver: TrackedResizeObserver,
    IntersectionObserver: TrackedIntersectionObserver,
    matchMedia,
    addCleanup(cleanup: () => void) {
      cleanups.push(cleanup);
    },
    ready() {
      ready.splice(0).forEach((listener) => {
        const event = new Event("DOMContentLoaded");
        if (typeof listener === "function") listener.call(document, event);
        else listener.handleEvent(event);
      });
    },
    point(event: { clientX: number; clientY: number }) {
      const rect = frame.getBoundingClientRect();
      return { x: (event.clientX - rect.x) / scale, y: (event.clientY - rect.y) / scale };
    },
    rect(node: Element) {
      const rect = node.getBoundingClientRect();
      const origin = frame.getBoundingClientRect();
      return {
        x: (rect.x - origin.x) / scale,
        y: (rect.y - origin.y) / scale,
        left: (rect.left - origin.left) / scale,
        top: (rect.top - origin.top) / scale,
        right: (rect.right - origin.left) / scale,
        bottom: (rect.bottom - origin.top) / scale,
        width: rect.width / scale,
        height: rect.height / scale,
      };
    },
  };
}
