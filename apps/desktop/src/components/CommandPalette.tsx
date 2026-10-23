import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
  Code2,
  FolderGit2,
  HardDrive,
  MessageSquarePlus,
  Newspaper,
  Play,
  Rocket,
  Settings,
  Sparkles,
  Terminal,
  Workflow,
} from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { useUi } from "../stores/ui";

function Item({
  icon,
  children,
  onSelect,
  hint,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  hint?: string;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-[13px] text-muted data-[selected=true]:bg-surface-2 data-[selected=true]:text-fg"
    >
      <span className="text-subtle">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {hint ? <span className="text-[11px] text-subtle">{hint}</span> : null}
    </Command.Item>
  );
}

export function CommandPalette() {
  const { paletteOpen: open, setPaletteOpen: setOpen } = useUi();
  const navigate = useNavigate();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, enabled: open });
  const workflows = useQuery({ queryKey: ["workflows"], queryFn: api.workflows, enabled: open });
  const recipes = useQuery({ queryKey: ["recipes"], queryFn: api.recipes, enabled: open });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useUi.getState().paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const go = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="命令面板"
      overlayClassName="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]"
      contentClassName="fixed left-1/2 top-[18%] z-50 w-[min(620px,92vw)] -translate-x-1/2 overflow-hidden rounded-2xl border bg-elevated shadow-2xl animate-fade-in"
    >
      <Command.Input
        placeholder="搜索页面、项目、工作流，或输入问题…"
        className="h-12 w-full border-b bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-subtle"
      />
      <Command.List className="max-h-[420px] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-subtle">
          没有匹配项
        </Command.Empty>
        <Command.Group
          heading="导航"
          className="px-1 text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
        >
          <Item
            icon={<MessageSquarePlus className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/", search: {} }))}
          >
            新对话
          </Item>
          <Item
            icon={<FolderGit2 className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/projects" }))}
          >
            项目中心
          </Item>
          <Item
            icon={<Rocket className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/deploy" }))}
          >
            部署中心
          </Item>
          <Item
            icon={<Newspaper className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/feed" }))}
          >
            技术热榜
          </Item>
          <Item
            icon={<Workflow className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/workflows" }))}
          >
            工作流
          </Item>
          <Item
            icon={<Sparkles className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/skills" }))}
          >
            技能
          </Item>
          <Item
            icon={<HardDrive className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/disk" }))}
          >
            磁盘清理
          </Item>
          <Item
            icon={<Settings className="h-4 w-4" />}
            onSelect={() => go(() => navigate({ to: "/settings" }))}
          >
            设置
          </Item>
        </Command.Group>
        {projects.data?.length ? (
          <Command.Group
            heading="在 Cursor 中打开"
            className="px-1 text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {projects.data.slice(0, 30).map((p) => (
              <Item
                key={`c-${p.id}`}
                icon={<Code2 className="h-4 w-4" />}
                hint={p.platform}
                onSelect={() => go(() => void api.launchProject(p.id, "cursor"))}
              >
                {p.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}
        {projects.data?.length ? (
          <Command.Group
            heading="用 Claude Code 打开"
            className="px-1 text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {projects.data.slice(0, 30).map((p) => (
              <Item
                key={`t-${p.id}`}
                icon={<Terminal className="h-4 w-4" />}
                onSelect={() => go(() => void api.launchProject(p.id, "claude"))}
              >
                claude · {p.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}
        {recipes.data?.length ? (
          <Command.Group
            heading="部署"
            className="px-1 text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {recipes.data.map((r) => (
              <Item
                key={r.id}
                icon={<Rocket className="h-4 w-4" />}
                onSelect={() =>
                  go(() => void api.runRecipe(r.id).then(() => navigate({ to: "/deploy" })))
                }
              >
                部署 {r.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}
        {workflows.data?.length ? (
          <Command.Group
            heading="工作流"
            className="px-1 text-[11px] text-subtle [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {workflows.data.map((w) => (
              <Item
                key={w.id}
                icon={<Play className="h-4 w-4" />}
                onSelect={() => go(() => navigate({ to: "/workflows/$id", params: { id: w.id } }))}
              >
                {w.name}
              </Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
