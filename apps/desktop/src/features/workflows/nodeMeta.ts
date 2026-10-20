import {
  Bot,
  Brain,
  CircleStop,
  GitBranch,
  GitFork,
  Globe,
  Bell,
  Play,
  Repeat,
  Rocket,
  ShieldCheck,
  SquareTerminal,
  Type,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { NodeType } from "@agentdesk/workflow/dsl";

export const NODE_ICON: Record<NodeType, LucideIcon> = {
  start: Play,
  end: CircleStop,
  text: Type,
  llm: Brain,
  agent: Bot,
  tool: Wrench,
  condition: GitFork,
  loop: Repeat,
  approval: ShieldCheck,
  http: Globe,
  shell: SquareTerminal,
  git: GitBranch,
  deploy: Rocket,
  notify: Bell,
};

export const NODE_COLOR: Record<string, string> = {
  基础: "#8a8f98",
  AI: "#8b7bff",
  逻辑: "#f5a524",
  集成: "#3ea8ff",
};

/** 多出口节点的分支句柄 */
export const NODE_HANDLES: Partial<Record<NodeType, Array<{ id: string; label: string }>>> = {
  condition: [
    { id: "true", label: "是" },
    { id: "false", label: "否" },
  ],
  loop: [
    { id: "body", label: "循环体" },
    { id: "done", label: "完成" },
  ],
};

export function handleLabel(
  sourceType: NodeType | undefined,
  handle: string | null | undefined,
): string | undefined {
  if (!sourceType || !handle) return undefined;
  return NODE_HANDLES[sourceType]?.find((h) => h.id === handle)?.label;
}
