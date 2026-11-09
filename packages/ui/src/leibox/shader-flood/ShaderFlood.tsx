import { useEffect, useRef } from "react";
import { cn } from "../../cn";
import { mountShaderFlood, type ShaderFloodOptions } from "./ShaderFloodEngine.js";
import type { MotionController } from "./motion-runtime";

export type ShaderFloodItem = NonNullable<ShaderFloodOptions["items"]>[number];

type ShaderFloodController = Omit<MotionController, "update"> & {
  update(options: ShaderFloodOptions): void;
};

const GRID_OVERRIDE = `
.sf-scene{padding:0!important;background:transparent!important;min-height:0!important;color:inherit}
.sf-stage{max-width:100%;margin:0}
.sf-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}

.sf-card{
  position:relative;
  min-height:204px;
  padding:22px 22px 20px;
  border-radius:24px;
  border:1px solid rgba(255,255,255,.72);
  background:
    linear-gradient(165deg,rgba(255,255,255,.94),rgba(246,245,250,.78));
  box-shadow:
    inset 0 1px 1px rgba(255,255,255,.95),
    inset 0 0 0 1px rgba(255,255,255,.18),
    0 1px 2px rgba(40,36,56,.04),
    0 14px 36px -18px rgba(40,36,56,.18);
  transition:
    transform .28s cubic-bezier(.2,.8,.2,1),
    box-shadow .28s cubic-bezier(.2,.8,.2,1),
    border-color .28s ease;
  -webkit-font-smoothing:antialiased;
}
.sf-card::before{
  content:"";
  position:absolute;
  inset:0;
  z-index:0;
  border-radius:inherit;
  pointer-events:none;
  background:
    radial-gradient(ellipse 90% 70% at 8% 0%,color-mix(in srgb,var(--sf-accent) 22%,transparent),transparent 58%),
    radial-gradient(ellipse 70% 55% at 100% 100%,color-mix(in srgb,var(--sf-accent) 10%,transparent),transparent 52%);
  opacity:.95;
}
.sf-card:hover:not([data-active=true]){
  transform:translateY(-3px);
  border-color:color-mix(in srgb,var(--sf-accent) 34%,rgba(228,228,231,.7));
  box-shadow:
    inset 0 1px 1px rgba(255,255,255,.98),
    0 2px 4px rgba(40,36,56,.05),
    0 22px 48px -20px color-mix(in srgb,var(--sf-accent) 28%,rgba(40,36,56,.22));
}
.sf-card:active{transform:translateY(-1px)}
.sf-card:focus-visible{
  outline:2px solid color-mix(in srgb,var(--sf-accent) 70%,#71717a);
  outline-offset:3px;
}

.sf-icon{
  width:42px;
  height:42px;
  border-radius:14px;
  background:color-mix(in srgb,var(--sf-accent) 14%,#fff);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb,var(--sf-accent) 26%,transparent),
    0 6px 14px -8px color-mix(in srgb,var(--sf-accent) 45%,transparent);
  color:var(--sf-accent);
  transition:background .2s,box-shadow .2s,color .2s;
}
.sf-icon svg{width:20px;height:20px}

.sf-content{padding-top:36px}
.sf-title{
  font-size:17px;
  line-height:1.3;
  font-weight:620;
  letter-spacing:-.03em;
  color:#1c1b22;
}
.sf-description{
  margin-top:8px;
  font-size:12.5px;
  line-height:1.5;
  font-weight:450;
  color:#6b6778;
  display:-webkit-box;
  -webkit-line-clamp:3;
  -webkit-box-orient:vertical;
  overflow:hidden;
}

.sf-card[data-active=true]{
  border-color:transparent;
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.18),
    0 18px 44px -16px color-mix(in srgb,var(--sf-accent) 42%,rgba(20,16,28,.35));
}
.sf-card[data-active=true] .sf-icon{
  background:rgba(255,255,255,.2);
  color:#fff;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.32);
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
}
.sf-card[data-active=true] .sf-title{color:#fff;text-shadow:0 1px 10px rgba(0,0,0,.22)}
.sf-card[data-active=true] .sf-description{color:rgba(255,255,255,.86);text-shadow:0 1px 8px rgba(0,0,0,.18)}

.sf-scene[data-theme=dark] .sf-card{
  border-color:rgba(219,214,255,.12);
  background:linear-gradient(165deg,rgba(54,51,70,.92),rgba(28,28,38,.78));
  box-shadow:
    inset 0 1px 1px rgba(255,255,255,.08),
    0 16px 42px -18px rgba(0,0,0,.48);
}
.sf-scene[data-theme=dark] .sf-card::before{
  background:
    radial-gradient(ellipse 90% 70% at 8% 0%,color-mix(in srgb,var(--sf-accent) 28%,transparent),transparent 58%),
    radial-gradient(ellipse 70% 55% at 100% 100%,color-mix(in srgb,var(--sf-accent) 12%,transparent),transparent 52%);
}
.sf-scene[data-theme=dark] .sf-card:hover:not([data-active=true]){
  border-color:color-mix(in srgb,var(--sf-accent) 40%,rgba(219,214,255,.14));
  box-shadow:
    inset 0 1px 1px rgba(255,255,255,.1),
    0 22px 48px -18px color-mix(in srgb,var(--sf-accent) 30%,rgba(0,0,0,.55));
}
.sf-scene[data-theme=dark] .sf-icon{
  background:color-mix(in srgb,var(--sf-accent) 22%,rgba(18,18,26,.85));
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--sf-accent) 34%,transparent);
}
.sf-scene[data-theme=dark] .sf-title{color:#f4f3f8}
.sf-scene[data-theme=dark] .sf-description{color:#a8a4b5}

@container sf-width (max-width:520px){.sf-grid{grid-template-columns:1fr}.sf-card{min-height:176px}}
@media (prefers-reduced-motion:reduce){
  .sf-card,.sf-icon{transition:none!important}
  .sf-card:hover:not([data-active=true]){transform:none}
}
`;

/** LeiBox shader-flood：液体注入卡片；支持业务 items 与点击回调。 */
export function ShaderFlood({
  options,
  className,
  onItemSelect,
}: {
  options?: ShaderFloodOptions;
  className?: string;
  onItemSelect?: (index: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ShaderFloodController | null>(null);
  const selectRef = useRef(onItemSelect);
  selectRef.current = onItemSelect;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const instance = mountShaderFlood(node, options);
    controller.current = instance;

    const style = node.ownerDocument.createElement("style");
    style.setAttribute("data-agentdesk", "shader-flood-layout");
    style.textContent = GRID_OVERRIDE;
    instance.root.append(style);

    const onClick = (event: Event) => {
      const target = event.target as Element | null;
      const card = target?.closest?.(".sf-card") as HTMLElement | null;
      if (!card || !instance.root.contains(card)) return;
      const index = Number(card.dataset.index);
      if (Number.isFinite(index)) selectRef.current?.(index);
    };
    instance.root.addEventListener("click", onClick);

    return () => {
      instance.root.removeEventListener("click", onClick);
      instance.destroy();
      controller.current = null;
    };
    // Mount once; options sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    controller.current?.update(options ?? {});
  }, [options]);

  return (
    <div
      ref={host}
      className={cn(className)}
      data-leibox="shader-flood"
      data-motion-component="shader-flood"
    />
  );
}
