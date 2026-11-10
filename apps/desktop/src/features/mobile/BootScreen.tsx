import { useEffect, useRef } from "react";
import { AiImageGeneration } from "./leibox/ai-generating/AiImageGeneration";

export function BootScreen({ label = "正在检查登录状态" }: { label?: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const polish = () => {
      const surface = root.querySelector<HTMLElement>("[data-motion-surface]");
      const shadow = surface?.shadowRoot;
      if (!shadow) return false;
      let style = shadow.querySelector<HTMLStyleElement>("#agentdesk-boot");
      if (!style) {
        style = document.createElement("style");
        style.id = "agentdesk-boot";
        shadow.appendChild(style);
      }
      style.textContent = `
        :host{display:block;width:min(280px,78vw);margin:0 auto}
        .motion-frame,.motion-body{width:100%!important;transform:none!important;min-height:0!important}
      `;
      return true;
    };
    if (polish()) return;
    const observer = new MutationObserver(() => {
      if (polish()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="m-boot">
      <div ref={host} className="m-boot-motion" aria-hidden="true">
        <AiImageGeneration />
      </div>
      <span className="m-boot-label">{label}</span>
    </div>
  );
}
