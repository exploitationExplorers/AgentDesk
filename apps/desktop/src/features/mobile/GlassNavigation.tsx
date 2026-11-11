import { useEffect, useRef } from "react";
import { GlassTabMenu } from "./leibox/glass-tab-menu/GlassTabMenu";

const tabs = ["工作区", "任务", "审批", "设置"] as const;
const navigationOptions = { height: 65 };

export function GlassNavigation({
  active,
  onChange,
  onCreate,
}: {
  active: number;
  onChange: (index: number) => void;
  onCreate: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const callback = useRef({ onChange, onCreate });
  callback.current = { onChange, onCreate };

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let observer: MutationObserver | undefined;
    const sync = () => {
      const surface = container.querySelector<HTMLElement>("[data-motion-surface]");
      const root = surface?.shadowRoot;
      const demo = root?.querySelector<HTMLElement>(".glass-tab-demo");
      if (!root || !demo) return false;
      let style = root.querySelector<HTMLStyleElement>("#agentdesk-navigation-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "agentdesk-navigation-style";
        root.appendChild(style);
      }
      style.textContent = `
        :host{height:65px!important;overflow:visible!important}
        .motion-frame{width:100%!important;height:65px!important;transform:none!important;overflow:visible}
        .motion-body,.glass-tab-demo{width:100%;height:65px;min-height:65px;overflow:visible;background:transparent}
        .gt-stage{position:relative;left:auto;top:auto;width:100%;height:65px;transform:none;transform-origin:top left}
        .gt-cluster{left:0;bottom:0;width:100%;height:65px}
        .gt-panel{left:0!important;bottom:0;width:100%!important;height:65px!important;border:1px solid #31415b;border-radius:17px!important;background:rgba(17,26,43,.95);box-shadow:0 10px 30px #0008,inset 0 1px #ffffff06;backdrop-filter:blur(22px) saturate(1.2);-webkit-backdrop-filter:blur(22px) saturate(1.2)}
        .gt-tabs{left:0;bottom:0;width:100%;height:65px;padding:6px;grid-template-columns:repeat(4,minmax(0,1fr));transform:none!important}
        .gt-selection,.gt-lens{left:6px;top:6px;width:calc((100% - 12px)/4);height:calc(100% - 12px);border-radius:11px;border:1px solid #34536f;background:linear-gradient(#21354c,#172b40);box-shadow:inset 0 1px #ffffff0a;transform:translateX(calc(var(--navigation-selection,0)*100%))!important}
        .gt-tab{width:100%;height:100%;border-radius:11px;display:flex;flex-direction:column;gap:5px;color:#7d90ae}
        .gt-tab[aria-selected=true]{color:#a3ddf5}
        .gt-tab .gt-icon{width:19px;height:19px}
        .gt-tab::after{content:attr(aria-label);font:550 11px/1.1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:currentColor;white-space:nowrap}
        .gt-tab:focus-visible,.gt-toggle:focus-visible{outline:3px solid #b17636;outline-offset:2px}
        .gt-toggle{display:none!important}
        .gt-menu,.gt-sr{display:none!important}
        @media(prefers-reduced-motion:reduce){.gt-selection,.gt-lens{transition:none!important}}
      `;
      demo.setAttribute("role", "navigation");
      demo.setAttribute("aria-label", "主导航");
      root.querySelector(".gt-tabs")?.setAttribute("aria-label", "主导航");
      const create = root.querySelector(".gt-toggle");
      create?.setAttribute("aria-label", "新建任务");
      create?.removeAttribute("aria-expanded");
      create?.removeAttribute("aria-controls");
      root.querySelectorAll<HTMLButtonElement>(".gt-tab").forEach((button, index) => {
        const label = tabs[index];
        if (label) {
          button.setAttribute("aria-label", label);
          button.setAttribute("title", label);
          button.removeAttribute("aria-controls");
        }
      });
      if (!observer) {
        // 动画每帧都会重写 selection；重绘只同步视觉，不能触发页面导航。
        const paint = () => {
          const position = Number(demo.dataset.indicator ?? demo.dataset.selection);
          if (Number.isFinite(position))
            demo.style.setProperty("--navigation-selection", String(position));
        };
        observer = new MutationObserver(paint);
        observer.observe(demo, { attributes: true, attributeFilter: ["data-indicator"] });
        paint();
      }
      return true;
    };
    if (!sync()) {
      const retry = new MutationObserver(() => {
        if (sync()) retry.disconnect();
      });
      retry.observe(container, { childList: true, subtree: true });
      return () => {
        retry.disconnect();
        observer?.disconnect();
      };
    }
    return () => {
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const root = container.querySelector<HTMLElement>("[data-motion-surface]")?.shadowRoot;
    const selected = Number(root?.querySelector<HTMLElement>(".glass-tab-demo")?.dataset.selection);
    if (selected !== active) {
      syncing.current = true;
      try {
        root?.querySelectorAll<HTMLButtonElement>(".gt-tab")[active]?.click();
      } finally {
        syncing.current = false;
      }
    }
  }, [active]);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const activate = (event: Event) => {
      const path = event.composedPath();
      if (path.some((node) => node instanceof Element && node.classList.contains("gt-toggle"))) {
        // 此处加号直接创建任务，不展开组件的演示菜单。
        event.preventDefault();
        event.stopImmediatePropagation();
        callback.current.onCreate();
        return;
      }
      const button = path.find(
        (node): node is HTMLButtonElement =>
          node instanceof HTMLButtonElement && node.classList.contains("gt-tab"),
      );
      if (button && !syncing.current) {
        const buttons = [...button.parentElement!.querySelectorAll(".gt-tab")];
        callback.current.onChange(buttons.indexOf(button));
      }
    };
    const keydown = (event: KeyboardEvent) => {
      const button = event
        .composedPath()
        .find(
          (node): node is HTMLButtonElement =>
            node instanceof HTMLButtonElement && node.classList.contains("gt-tab"),
        );
      if (!button) return;
      const buttons = [...button.parentElement!.querySelectorAll<HTMLButtonElement>(".gt-tab")];
      const index = buttons.indexOf(button);
      const next = { ArrowRight: (index + 1) % 4, ArrowLeft: (index + 3) % 4, Home: 0, End: 3 }[
        event.key
      ];
      if (next === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      buttons[next]?.focus();
      buttons[next]?.click();
    };
    container.addEventListener("click", activate, true);
    container.addEventListener("keydown", keydown, true);
    return () => {
      container.removeEventListener("click", activate, true);
      container.removeEventListener("keydown", keydown, true);
    };
  }, []);

  return (
    <div className="m-glass-nav" ref={host} aria-label="主导航">
      <GlassTabMenu options={navigationOptions} />
    </div>
  );
}
