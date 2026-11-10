import { useEffect, useMemo, useRef } from "react";
import type { Task } from "@agentdesk/shared";
import { StackedMetadata } from "./leibox/stacked-metadata/StackedMetadata";
import { displayTime } from "./hooks";

const priorityFor = (status: string): string => {
  if (status.startsWith("awaiting_")) return "审批";
  if (["queued", "planning", "running"].includes(status)) return "执行中";
  if (status === "failed") return "失败";
  if (["completed", "closed"].includes(status)) return "完成";
  if (status === "cancelled") return "取消";
  return status;
};

export function RecentTasksStack({
  tasks,
  heading = "最近任务",
  onSelect,
}: {
  tasks: Task[];
  heading?: string;
  onSelect: (taskId: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  const options = useMemo(
    () => ({
      heading,
      theme: "light" as const,
      expanded: 0,
      items: tasks.slice(0, 6).map((task) => ({
        title: task.title || "未命名任务",
        priority: priorityFor(task.status),
        date: displayTime(task.updatedAt),
        assignee: task.agent ?? "native-bot",
      })),
      onExpandChange: (index: number) => {
        const task = tasksRef.current[index];
        if (task) selectRef.current(task.id);
      },
    }),
    [heading, tasks],
  );

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const polish = () => {
      const surface = root.querySelector<HTMLElement>("[data-motion-surface]");
      const shadow = surface?.shadowRoot;
      if (!shadow) return false;
      let style = shadow.querySelector<HTMLStyleElement>("#agentdesk-task-stack");
      if (!style) {
        style = document.createElement("style");
        style.id = "agentdesk-task-stack";
        shadow.appendChild(style);
      }
      style.textContent = `
        :host{display:block;width:100%}
        .motion-frame,.motion-body{width:100%!important;transform:none!important;min-height:0!important}
        .sm-stage{padding:0!important;background:transparent!important}
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

  if (!tasks.length) return null;

  return (
    <div ref={host} className="m-task-stack">
      <StackedMetadata options={options} />
    </div>
  );
}
