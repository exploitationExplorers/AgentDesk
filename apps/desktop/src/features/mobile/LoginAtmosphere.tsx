import { useEffect, useRef } from "react";
import { BlueFlutedGlass } from "./leibox/blue-fluted-glass/BlueFlutedGlass";

/** Login side atmosphere — hides LeiBox wordmark and fills the panel. */
export function LoginAtmosphere() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const hide = () => {
      const surface = root.querySelector<HTMLElement>("[data-motion-surface]");
      const shadow = surface?.shadowRoot;
      if (!shadow) return false;
      let style = shadow.querySelector<HTMLStyleElement>("#agentdesk-login-atmosphere");
      if (!style) {
        style = document.createElement("style");
        style.id = "agentdesk-login-atmosphere";
        shadow.appendChild(style);
      }
      style.textContent = `
        :host{display:block;width:100%;height:100%}
        .motion-frame,.motion-body,.bfg-stage{width:100%!important;height:100%!important;min-height:100%!important;margin:0!important;transform:none!important}
        .bfg-logo{display:none!important}
        .bfg-canvas{width:100%!important;height:100%!important}
      `;
      return true;
    };
    if (hide()) return;
    const observer = new MutationObserver(() => {
      if (hide()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={host} className="m-login-atmosphere" aria-hidden="true">
      <BlueFlutedGlass />
    </div>
  );
}
