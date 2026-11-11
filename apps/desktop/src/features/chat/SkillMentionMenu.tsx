import { Sparkles } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { GlassSelection, cn } from "@agentdesk/ui";
import type { SkillInfo } from "../../lib/api";

function highlightMatch(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-[3px] bg-brand/20 px-0.5 text-brand not-italic">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

export function SkillMentionMenu({
  items,
  index,
  query = "",
  onHover,
  onSelect,
  onClose,
}: {
  items: SkillInfo[];
  index: number;
  query?: string;
  onHover: (index: number) => void;
  onSelect: (skill: SkillInfo) => void;
  onClose: () => void;
}) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [index, items]);

  if (!items.length) return null;

  return (
    <div
      id={id}
      role="listbox"
      aria-label="选择技能"
      className="lb-popover flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-surface/95 shadow-[0_18px_48px_-20px_rgba(15,23,42,0.55)] backdrop-blur-md"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <p className="text-[11px] font-medium tracking-wide text-muted">输入以筛选技能</p>
        <button
          type="button"
          className="rounded-lg px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-brand"
          onClick={onClose}
        >
          Esc
        </button>
      </div>
      <div ref={listRef} className="relative isolate min-h-0 flex-1 overflow-y-auto px-1 py-1">
        <GlassSelection
          selector='[role="option"][aria-selected="true"]'
          className="skill-mention-selection rounded-xl"
        />
        {items.map((skill, offset) => {
          const active = offset === index;
          return (
            <button
              key={skill.name}
              type="button"
              role="option"
              aria-selected={active}
              data-active={active ? "true" : undefined}
              className={cn(
                "relative z-[1] flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-[color,transform] duration-150",
                active ? "text-fg" : "text-fg/90 hover:text-fg",
              )}
              onMouseEnter={() => onHover(offset)}
              onClick={() => onSelect(skill)}
            >
              <span
                className={cn(
                  "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-[background-color,color,transform,box-shadow] duration-200",
                  active
                    ? "scale-105 bg-brand/18 text-brand shadow-[0_0_0_1px_color-mix(in_srgb,var(--ad-brand)_28%,transparent),0_8px_18px_-10px_color-mix(in_srgb,var(--ad-brand)_55%,transparent)]"
                    : "bg-surface-2 text-muted",
                )}
              >
                <Sparkles className={cn("h-3.5 w-3.5", active && "motion-safe:animate-pulse")} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">
                    @{highlightMatch(skill.name, query)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors",
                      active ? "bg-brand/12 text-brand" : "bg-surface-2 text-muted",
                    )}
                  >
                    Skill
                  </span>
                </span>
                <span className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted">
                  {skill.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-border/60 px-3 py-1.5 text-[10px] text-muted">
        Enter / Tab 插入 · ↑↓ 选择 · Esc 关闭
      </div>
    </div>
  );
}
