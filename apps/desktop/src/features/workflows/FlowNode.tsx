import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { NODE_SPECS, type NodeRunStatus, type NodeType } from "@agentdesk/workflow/dsl";
import { cn } from "@agentdesk/ui";
import { NODE_COLOR, NODE_HANDLES, NODE_ICON } from "./nodeMeta";

export type FlowNodeData = {
  kind: NodeType;
  label: string;
  config: Record<string, unknown>;
  status?: NodeRunStatus;
};
export type FlowNode = Node<FlowNodeData, "wf">;

const STATUS_RING: Record<NodeRunStatus, string> = {
  pending: "",
  running: "ring-2 ring-info shadow-[0_0_24px_-4px_var(--ad-info)]",
  succeeded: "ring-2 ring-success/70",
  failed: "ring-2 ring-danger",
  skipped: "opacity-50",
};

function summary(kind: NodeType, config: Record<string, unknown>): string {
  const first = NODE_SPECS[kind].fields[0];
  const value = first ? config[first.key] : undefined;
  return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

export const FlowNodeView = memo(function FlowNodeView({ data, selected }: NodeProps<FlowNode>) {
  const spec = NODE_SPECS[data.kind];
  const Icon = NODE_ICON[data.kind];
  const color = NODE_COLOR[spec.group] ?? "#8a8f98";
  const handles = NODE_HANDLES[data.kind];
  const text = summary(data.kind, data.config);

  return (
    <div
      className={cn(
        "w-[210px] rounded-2xl border bg-surface shadow-lg transition-shadow",
        selected ? "border-fg/40" : "border-border",
        data.status && STATUS_RING[data.status],
      )}
    >
      {data.kind !== "start" ? (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-subtle"
        />
      ) : null}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span
          className="grid h-6 w-6 place-items-center rounded-lg"
          style={{ background: `${color}22`, color }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-semibold">{data.label}</p>
          <p className="text-[10.5px] text-subtle">{spec.title}</p>
        </div>
      </div>
      {text ? (
        <p className="mx-3 mb-2.5 line-clamp-2 rounded-lg bg-surface-2 px-2 py-1 font-mono text-[10.5px] text-muted">
          {text}
        </p>
      ) : null}
      {handles ? (
        <div className="border-t px-3 py-1.5">
          {handles.map((h) => (
            <div
              key={h.id}
              className="relative flex h-6 items-center justify-end text-[10.5px] text-muted"
            >
              {h.label}
              <Handle
                id={h.id}
                type="source"
                position={Position.Right}
                className="!-right-[13px] !h-2.5 !w-2.5 !border-2 !border-surface !bg-brand"
                style={{ top: "50%" }}
              />
            </div>
          ))}
        </div>
      ) : data.kind !== "end" ? (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-brand"
        />
      ) : null}
    </div>
  );
});
