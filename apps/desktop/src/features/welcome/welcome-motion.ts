const SVG_NS = "http://www.w3.org/2000/svg";

type ActorKey = "instinct" | "grok" | "alfred" | "jolly" | "clawd" | "molty" | "cue";
interface ActorDefinition {
  key: ActorKey;
  name: string;
  size: number;
  width: number;
  top: number;
  height: number;
}
interface Actor extends ActorDefinition {
  element: HTMLDivElement;
  shadow: HTMLDivElement;
  label: HTMLDivElement;
  slot: HTMLElement;
  period: number;
  phase: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  sx: number;
  sy: number;
  slotScale: number;
}

const ACTORS: readonly ActorDefinition[] = [
  { key: "instinct", name: "Instinct", size: 0.78, width: 0.21, top: 0.1, height: 0.85 },
  { key: "grok", name: "Grok Bot", size: 0.62, width: 0.97, top: 0.01, height: 0.97 },
  { key: "alfred", name: "ChatGPT dots", size: 0.88, width: 0.82, top: 0.09, height: 0.82 },
  { key: "jolly", name: "Muse", size: 1.05, width: 0.88, top: 0.07, height: 0.87 },
  { key: "clawd", name: "Claude", size: 0.8, width: 0.9, top: 0.26, height: 0.55 },
  { key: "molty", name: "OpenClaw", size: 0.88, width: 0.86, top: 0.06, height: 0.84 },
  { key: "cue", name: "Manus Cue", size: 0.82, width: 0.87, top: 0.1, height: 0.86 },
];
const WAVE = [-10, 18, -6, -16, 14, -8, 10];
const MESSAGE_THRESHOLDS = [0.6, 0.63, 0.66, 0.69, 0.72, 0.8, 0.83, 0.86];

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}
function smooth(start: number, end: number, value: number) {
  const progress = clamp((value - start) / (end - start), 0, 1);
  return progress * progress * (3 - 2 * progress);
}
function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}
function easeOutBack(progress: number) {
  return 1 + 2.5 * Math.pow(progress - 1, 3) + 1.5 * Math.pow(progress - 1, 2);
}
function easeInOut(progress: number) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}
function actorSvg(key: string, size?: number) {
  const svg = document.createElementNS(SVG_NS, "svg");
  if (size !== undefined) {
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
  }
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#m-${key}`);
  svg.append(use);
  return svg;
}

// 动画只操作此页面的节点和滚动容器，离开路由时完整释放，兼容 React StrictMode。
export function mountWelcomeMotion(root: HTMLDivElement): () => void {
  const query = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Welcome animation element missing: ${selector}`);
    return element;
  };
  const all = <T extends HTMLElement = HTMLElement>(selector: string) => [
    ...root.querySelectorAll<T>(selector),
  ];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const controller = new AbortController();
  const pendingFrames = new Set<number>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  let alive = true;
  let frameId = 0;
  const nextFrame = (callback: () => void) => {
    const id = requestAnimationFrame(() => {
      pendingFrames.delete(id);
      if (alive) callback();
    });
    pendingFrames.add(id);
  };

  const stage = query("#stage");
  const stageWrap = query("#stageWrap");
  const hero = query("#hero");
  const beat = query("#beat");
  const side = query("#side");
  const side2 = query("#side2");
  const chat = query("#chat");
  const chatHead = query("#chat .chat-head");
  const nav = query("#nav");
  const dm = query("#dm");
  const dmCap = query("#dmCap");
  const dmBody = query("#dmBody");
  const dmHead = query("#dm .dm-head");
  const dmLater = all("#dmBody .later");
  const dmTyping = query("#dmTyping");
  const dmItems = [...dmBody.children].filter(
    (element): element is HTMLElement => element instanceof HTMLElement && element !== dmTyping,
  );
  const slots = all("#slots .slot");
  const messages = all("#list .msg");
  const list = query("#list");
  const viewport = query("#vp");
  const typing = query("#typing");
  const typingAvatar = query("#typingAv");
  const originalTypingChildren = [...typingAvatar.childNodes].map((node) => node.cloneNode(true));

  const svhProbe = document.createElement("div");
  svhProbe.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:100vh;height:100svh;visibility:hidden;pointer-events:none";
  root.append(svhProbe);

  const actors: Actor[] = ACTORS.map((definition, index) => {
    const element = document.createElement("div");
    element.className = "actor";
    element.setAttribute("aria-hidden", "true");
    const shadow = document.createElement("div");
    shadow.className = "shadow";
    const label = document.createElement("div");
    label.className = "name";
    label.textContent = definition.name;
    element.append(shadow, actorSvg(definition.key, Math.round(150 * definition.size)), label);
    stage.append(element);
    const slot = slots[index];
    if (!slot) throw new Error(`Welcome avatar slot missing: ${definition.key}`);
    return {
      ...definition,
      element,
      shadow,
      label,
      slot,
      period: 3.4 + index * 0.37,
      phase: index * 1.3,
      ax: 0,
      ay: 0,
      bx: 0,
      by: 0,
      sx: 0,
      sy: 0,
      slotScale: 1,
    };
  });

  const audience = query("#aud");
  const audienceTrack = query("#aud .aud-track");
  const audienceSet = query("#aud .aud-set");
  const audienceCopy = audienceSet.cloneNode(true) as HTMLElement;
  audienceCopy.setAttribute("aria-hidden", "true");
  audienceTrack.append(audienceCopy);
  audience.style.setProperty("--aud-t", `${Math.max(20, audienceSet.offsetWidth / 36)}s`);
  audience.classList.add("run");

  const layoutState = { phone: false, initialScale: 1, centerOffset: 0, dmMax: 0, dmKey: "" };
  let progress = 0;
  let targetProgress = 0;
  let lastTime = performance.now();
  let startedAt = performance.now();
  let lastVisible = -2;
  let lastTyping = -2;

  function layout() {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const fit = Math.min(height, svhProbe.offsetHeight || height);
    const phone = width < 560;
    layoutState.phone = phone;
    hero.style.transform = "none";
    const send = query("#hero .send");
    if (phone) {
      const gap = 2;
      const span = actors.reduce((sum, actor) => sum + 150 * actor.size * actor.width, 0);
      const tallest = Math.max(...actors.map((actor) => 150 * actor.size * actor.height));
      layoutState.initialScale = Math.min(0.5, (width - 20 - gap * 6) / span);
      const navBottom = nav.offsetTop + nav.offsetHeight;
      audience.style.marginTop = "";
      send.style.marginTop = "";
      const rowTop = fit - 0.75 * tallest * layoutState.initialScale;
      const spare = Math.max(0, rowTop - 24 - navBottom - 14 - hero.offsetHeight);
      audience.style.marginTop = `${parseFloat(getComputedStyle(audience).marginTop) + Math.min(10, spare * 0.06)}px`;
      send.style.marginTop = `${parseFloat(getComputedStyle(send).marginTop) + Math.min(40, spare * 0.3)}px`;
      const heroHeight = hero.offsetHeight;
      const heroTop =
        navBottom + 14 + Math.max(0, (rowTop - 24 - navBottom - 14 - heroHeight) * 0.42);
      hero.style.top = `${heroTop}px`;
      const push = Math.max(0, heroTop + heroHeight + 24 - rowTop);
      let x = (width - span * layoutState.initialScale - gap * 6) / 2;
      actors.forEach((actor) => {
        const size = 150 * actor.size * layoutState.initialScale;
        const actualWidth = size * actor.width;
        actor.ax = x + actualWidth / 2;
        x += actualWidth + gap;
        actor.ay =
          fit +
          push -
          0.75 * actor.height * size -
          actor.top * size +
          size -
          75 * layoutState.initialScale;
      });
    } else {
      layoutState.initialScale = clamp(Math.min(width / 1800, height / 980), 0.55, 1);
      hero.style.top = "";
      audience.style.marginTop = "";
      send.style.marginTop = "";
      const heroBottom = hero.getBoundingClientRect().bottom - stage.getBoundingClientRect().top;
      let rowY = heroBottom + (height - heroBottom) * 0.46;
      const reach = Math.min(
        ...actors.map(
          (actor, index) =>
            ((WAVE[index] ?? 0) + 75 - 150 * actor.size * (1 - actor.top)) *
            layoutState.initialScale,
        ),
      );
      rowY = Math.max(rowY, heroBottom + 16 + 7 - reach);
      actors.forEach((actor, index) => {
        actor.ax = width * (0.08 + index * (0.84 / 6));
        actor.ay = rowY + (WAVE[index] ?? 0) * layoutState.initialScale;
      });
    }
    actors.forEach((actor, index) => {
      actor.bx = width / 2 + (index - 3) * (phone ? width * 0.1 : 118 * layoutState.initialScale);
      actor.by = height * 0.6 + Math.pow(index - 3, 2) * 5 * layoutState.initialScale;
    });
    const narrow = width < 900;
    const containerWidth = Math.min(1280, width - 96);
    const leftEdge = (width - containerWidth) / 2;
    const chatWidth = narrow ? width - 32 : Math.min(760, containerWidth * 0.6);
    const chatHeight = Math.min(800, fit - 140);
    const chatLeft = narrow ? 16 : leftEdge + containerWidth - chatWidth;
    const chatTop = Math.max(100, (fit - chatHeight) / 2 + 34);
    Object.assign(chat.style, {
      left: `${chatLeft}px`,
      top: `${chatTop}px`,
      width: `${chatWidth}px`,
      height: `${chatHeight}px`,
    });
    viewport.style.top = `${chatHead.offsetHeight}px`;
    layoutState.centerOffset = width / 2 - (chatLeft + chatWidth / 2);
    [side, side2].forEach((element) => {
      Object.assign(element.style, {
        left: `${leftEdge}px`,
        width: `${Math.max(320, containerWidth - chatWidth - 90)}px`,
        top: `${chatTop + chatHeight / 2 - 110}px`,
      });
    });
    dm.style.width = `${Math.min(390, width - 32)}px`;
    dm.style.height = "";
    dmBody.style.transform = "";
    const dmHeight = dm.offsetHeight;
    const dmLeft = narrow ? 16 : chatLeft + 24;
    const dmTop = phone
      ? chatTop + 40
      : Math.max(chatTop + 40, chatTop + (chatHeight - dmHeight) / 2 + 26);
    layoutState.dmMax = fit - 16 - dmTop;
    layoutState.dmKey = "";
    Object.assign(dm.style, { left: `${dmLeft}px`, top: `${dmTop}px` });
    Object.assign(dmCap.style, { left: `${dmLeft + 6}px`, top: `${dmTop - 30}px` });
    const previousTransform = chat.style.transform;
    chat.style.transform = "none";
    const stageRect = stage.getBoundingClientRect();
    actors.forEach((actor) => {
      const rect = actor.slot.getBoundingClientRect();
      actor.sx = rect.left - stageRect.left + rect.width / 2;
      actor.sy = rect.top - stageRect.top + rect.height / 2;
      const svg = actor.slot.querySelector("svg");
      actor.slotScale = svg ? parseFloat(getComputedStyle(svg).width) / (150 * actor.size) : 1;
    });
    chat.style.transform = previousTransform;
    lastVisible = -2;
  }

  function readScroll() {
    const total = stageWrap.offsetHeight - root.clientHeight;
    const top = stageWrap.getBoundingClientRect().top - root.getBoundingClientRect().top;
    targetProgress = total > 0 ? clamp(-top / total, 0, 1) : 0;
    nav.classList.toggle("scrolled", root.scrollTop > 8);
  }

  function render(now: number) {
    const heroOut = smooth(0.03, 0.16, progress);
    hero.style.opacity = String(1 - heroOut);
    hero.style.transform = `translateY(${-44 * heroOut}px)`;
    hero.style.filter = heroOut > 0.001 ? `blur(${heroOut * 6}px)` : "none";
    hero.style.pointerEvents = heroOut > 0.5 ? "none" : "auto";
    const converge = reduced ? 0 : smooth(0.06, 0.34, progress);
    const beatIn = smooth(0.15, 0.24, progress);
    const beatOut = smooth(0.33, 0.41, progress);
    beat.style.opacity = String(beatIn * (1 - beatOut));
    beat.style.transform = `translateY(${(1 - beatIn) * 18 - beatOut * 18}px)`;
    const chatIn = smooth(0.34, 0.46, progress);
    const slide = reduced ? 1 : smooth(0.52, 0.66, progress);
    const centerX = layoutState.centerOffset * (1 - slide);
    const centerY = (1 - chatIn) * 26;
    const recede = smooth(0.73, 0.81, progress);
    const recedeX = reduced || layoutState.phone ? 0 : 70 * recede;
    const recedeY = reduced ? 0 : -24 * recede;
    chat.style.opacity = String(chatIn * (1 - 0.5 * recede));
    chat.style.transform = `translate(${centerX + recedeX}px,${centerY + recedeY}px) scale(${(0.94 + 0.06 * chatIn) * (1 - (reduced ? 0 : 0.1) * recede)})`;
    chat.style.filter = recede > 0.001 ? `blur(${recede * 2.5}px)` : "none";
    const sideIn = smooth(0.57, 0.69, progress);
    const sideOut = smooth(0.72, 0.765, progress);
    side.style.opacity = String(sideIn * (1 - sideOut));
    side.style.transform = `translateY(${(1 - sideIn) * 22 - sideOut * 16}px)`;
    const conclusionIn = smooth(0.785, 0.84, progress);
    side2.style.opacity = String(conclusionIn);
    side2.style.transform = `translateY(${(1 - conclusionIn) * 22}px)`;
    const dmIn = smooth(0.75, 0.83, progress);
    dm.style.opacity = String(smooth(0.75, 0.775, progress));
    dm.style.transform = reduced
      ? "none"
      : `translate(${(1 - dmIn) * -30}px,${(1 - dmIn) * 50}px) scale(${0.95 + 0.05 * dmIn})`;
    dmCap.style.opacity = String(smooth(0.8, 0.85, progress));
    const elapsed = now - startedAt;
    const nameOpacity = 1 - smooth(0.03, 0.12, progress);
    actors.forEach((actor, index) => {
      const enter = reduced ? 1 : clamp((elapsed - 450 - index * 80) / 750, 0, 1);
      const enterScale = reduced ? 1 : easeOutBack(enter);
      const enterOpacity = clamp(enter * 1.6, 0, 1);
      const fly = reduced
        ? 0
        : smooth(0.4 + (6 - index) * 0.014, 0.55 + (6 - index) * 0.014, progress);
      const bob = reduced
        ? 0
        : Math.sin(((now / 1000) * 2 * Math.PI) / actor.period + actor.phase) *
          (layoutState.phone ? 4 : 7) *
          (1 - converge * 0.6) *
          (1 - fly);
      const x1 = lerp(actor.ax, actor.bx, converge);
      const y1 = lerp(actor.ay, actor.by, converge);
      const flyEase = easeInOut(fly);
      const x = lerp(x1, actor.sx + centerX, flyEase);
      const y = lerp(y1, actor.sy + centerY, flyEase) - Math.sin(Math.PI * fly) * 70 + bob;
      const initialScale = lerp(layoutState.initialScale, layoutState.initialScale * 0.8, converge);
      const scale = lerp(initialScale, actor.slotScale, flyEase) * enterScale;
      const rotate = Math.sin(Math.PI * fly) * (index - 3) * 5;
      actor.element.style.transform = `translate(${x - 75}px,${y - 75}px) rotate(${rotate}deg) scale(${scale})`;
      actor.element.style.opacity = String(
        reduced ? enterOpacity * (1 - chatIn) : enterOpacity * (1 - smooth(0.8, 1, fly)),
      );
      actor.label.style.opacity = String(nameOpacity);
      actor.shadow.style.opacity = String((1 - fly) * (1 - converge * 0.4));
      const slotProgress = reduced ? chatIn : smooth(0.72, 1, fly);
      actor.slot.style.opacity = String(slotProgress);
      actor.slot.style.transform = `scale(${0.5 + 0.5 * (reduced ? 1 : easeOutBack(slotProgress))})`;
    });
    let visible = -1;
    let typingFor = -1;
    messages.forEach((message, index) => {
      const threshold = MESSAGE_THRESHOLDS[index] ?? 1;
      const show = progress >= threshold;
      if (show) visible = index;
      message.classList.toggle("in", show);
      if (!show && progress >= threshold - 0.026 && progress > 0.58 && typingFor < 0)
        typingFor = index;
    });
    if (visible !== lastVisible || typingFor !== lastTyping) {
      lastVisible = visible;
      lastTyping = typingFor;
      const lastMessage = visible >= 0 ? messages[visible] : undefined;
      let bottom = lastMessage ? lastMessage.offsetTop + lastMessage.offsetHeight : 0;
      const nextMessage = messages[typingFor];
      if (typingFor >= 0 && nextMessage) {
        const key = nextMessage.dataset.a ?? "jolly";
        typingAvatar.className = `av av-${key}`;
        typingAvatar.replaceChildren(actorSvg(key));
        typing.style.top = `${bottom + 13}px`;
        typing.classList.add("on");
        bottom += 13 + 36;
      } else typing.classList.remove("on");
      list.style.transform = `translateY(${-Math.max(0, bottom + 18 - viewport.clientHeight)}px)`;
    }
    let dmTypingAt: number | null = null;
    dmLater.forEach((element) => {
      const threshold = Number(element.dataset.t);
      const show = progress >= threshold;
      element.classList.toggle("in", show);
      if (!show && element.dataset.agent && progress >= threshold - 0.025 && dmTypingAt === null)
        dmTypingAt = element.offsetTop;
    });
    if (dmTypingAt !== null) {
      dmTyping.style.top = `${dmTypingAt}px`;
      dmTyping.classList.add("on");
    } else dmTyping.classList.remove("on");
    if (layoutState.phone) {
      const state =
        dmLater.map((element) => (element.classList.contains("in") ? 1 : 0)).join("") +
        `,${dmTypingAt}`;
      if (state !== layoutState.dmKey) {
        layoutState.dmKey = state;
        let end = dmTypingAt !== null ? dmTypingAt + 36 : 0;
        dmItems.forEach((element) => {
          if (!element.classList.contains("later") || element.classList.contains("in"))
            end = Math.max(end, element.offsetTop + element.offsetHeight);
        });
        const fullHeight = dmHead.offsetHeight + end + 20;
        const height = Math.min(layoutState.dmMax, fullHeight);
        dm.style.height = `${height}px`;
        dmBody.style.transform = `translateY(${height - fullHeight}px)`;
      }
    }
  }

  function frame(now: number) {
    if (!alive) return;
    const delta = Math.min(64, now - lastTime);
    lastTime = now;
    progress = reduced
      ? targetProgress
      : progress + (targetProgress - progress) * (1 - Math.exp((-delta / 1000) * 9));
    if (Math.abs(targetProgress - progress) < 0.00005) progress = targetProgress;
    render(now);
    frameId = requestAnimationFrame(frame);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    },
    { root, threshold: 0.18, rootMargin: "0px 0px -6% 0px" },
  );
  all("[data-r], #wordmark, #final").forEach((element) => {
    if (reduced) element.classList.add("in");
    else observer.observe(element);
  });
  all<HTMLDetailsElement>(".qa").forEach((details) => {
    details.querySelector("summary")?.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        if (details.open) {
          details.classList.remove("open");
          const timer = setTimeout(
            () => {
              pendingTimers.delete(timer);
              if (alive && !details.classList.contains("open")) details.open = false;
            },
            reduced ? 0 : 450,
          );
          pendingTimers.add(timer);
        } else {
          details.open = true;
          nextFrame(() => details.classList.add("open"));
        }
      },
      { signal: controller.signal },
    );
  });
  const relayout = () => {
    if (alive) {
      layout();
      readScroll();
    }
  };
  root.addEventListener("scroll", readScroll, { passive: true, signal: controller.signal });
  window.addEventListener("resize", relayout, { signal: controller.signal });
  const resizeObserver = new ResizeObserver(relayout);
  resizeObserver.observe(root);
  layout();
  readScroll();
  progress = targetProgress;
  startedAt = performance.now();
  nextFrame(() => root.classList.add("loaded"));
  frameId = requestAnimationFrame(frame);
  void document.fonts.ready.then(() => {
    if (alive) relayout();
  });

  return () => {
    alive = false;
    controller.abort();
    cancelAnimationFrame(frameId);
    pendingFrames.forEach(cancelAnimationFrame);
    pendingTimers.forEach(clearTimeout);
    observer.disconnect();
    resizeObserver.disconnect();
    actors.forEach((actor) => actor.element.remove());
    svhProbe.remove();
    audienceCopy.remove();
    audience.classList.remove("run");
    audience.style.removeProperty("--aud-t");
    root.classList.remove("loaded");
    all(".in").forEach((element) => element.classList.remove("in"));
    all<HTMLDetailsElement>(".qa").forEach((details) => {
      details.open = false;
      details.classList.remove("open");
    });
    typingAvatar.replaceChildren(...originalTypingChildren);
  };
}
