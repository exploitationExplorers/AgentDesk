import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
} from "@xyflow/react";
import {
  Component,
  memo,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { RunNode } from "@agentdesk/shared";
import { Button, cn } from "@agentdesk/ui";
import {
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Route,
  ShieldAlert,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { AGENT_META, TOOL_LABELS } from "../../lib/agents";
import { FluidEdge } from "./FluidEdge";
import { buildFlowGraph, type FlowCardData, type FlowCardNode } from "./flow-layout";

const KIND_ICON: Record<FlowCardData["kind"], LucideIcon> = {
  run: Bot,
  tool: Wrench,
  route: Route,
  approval: ShieldAlert,
  note: CheckCircle2,
  delegate: ClipboardCheck,
};

const STATUS_RING: Record<FlowCardData["status"], string> = {
  queued: "",
  running: "ring-2 ring-info shadow-[0_0_24px_-4px_var(--ad-info)]",
  done: "ring-2 ring-success/50",
  error: "ring-2 ring-danger",
  waiting: "ring-2 ring-warning shadow-[0_0_24px_-4px_var(--ad-warning)]",
  rejected: "ring-2 ring-danger/70",
};

const FlowCardView = memo(function FlowCardView({ data, selected }: NodeProps<FlowCardNode>) {
  const RunIcon =
    data.kind === "run"
      ? (AGENT_META[data.agent as keyof typeof AGENT_META]?.icon ?? Bot)
      : KIND_ICON[data.kind];
  const StatusIcon =
    data.status === "running"
      ? Loader2
      : data.status === "error" || data.status === "rejected"
        ? XCircle
        : data.status === "waiting"
          ? ShieldAlert
          : null;

  return (
    <div
      className={cn(
        "code-flow-card w-[220px] rounded-2xl border bg-surface shadow-lg transition-shadow",
        selected ? "border-fg/40" : "border-border",
        STATUS_RING[data.status],
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-subtle"
      />
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-brand/15 text-brand">
          <RunIcon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold">{data.title}</p>
          <p className="text-[10.5px] text-subtle">
            {data.subtitle}
            {data.kind === "run" && data.detail ? ` · ${data.detail}` : null}
          </p>
        </div>
        {StatusIcon ? (
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              data.status === "running" && "animate-spin text-info",
              (data.status === "error" || data.status === "rejected") && "text-danger",
              data.status === "waiting" && "text-warning",
            )}
          />
        ) : null}
      </div>
      {data.detail && data.kind !== "run" ? (
        <p className="mx-3 mb-2.5 line-clamp-2 rounded-lg bg-surface-2 px-2 py-1 font-mono text-[10.5px] text-muted">
          {data.detail}
        </p>
      ) : (
        <div className="h-2" />
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-brand"
      />
    </div>
  );
});

const nodeTypes = { card: FlowCardView };
const edgeTypes = { fluid: FluidEdge };

/** React19 + xyflow 偶发 panZoom 清理异常时，吞掉错误并允许重挂载画布。 */
class FlowErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null; generation: number }
> {
  override state = { error: null as Error | null, generation: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[code-flow]", error.message, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, generation: this.state.generation + 1 });
    }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="grid h-full place-items-center gap-3 p-6 text-center">
          <p className="text-[13px] text-danger">流程图渲染异常：{this.state.error.message}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => this.setState((s) => ({ error: null, generation: s.generation + 1 }))}
          >
            重新加载
          </Button>
        </div>
      );
    }
    return (
      <div key={this.state.generation} className="h-full w-full">
        {this.props.children}
      </div>
    );
  }
}

export function FlowGraph({
  runsById,
  rootOrder,
  selectedRunId,
  onSelectRun,
}: {
  runsById: Record<string, RunNode>;
  rootOrder: string[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const { nodes, edges } = useMemo(
    () =>
      buildFlowGraph(runsById, rootOrder, selectedRunId, {
        agentLabel: (agent) => AGENT_META[agent as keyof typeof AGENT_META]?.label ?? agent,
        toolLabel: (name) => TOOL_LABELS[name] ?? name,
      }),
    [runsById, rootOrder, selectedRunId],
  );

  // 延迟两帧挂载画布：父容器（标签页切换）需先完成布局，否则首帧 panZoom 清理会抛异常。
  const [canvasReady, setCanvasReady] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setCanvasReady(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, []);

  if (!nodes.length) {
    return (
      <div className="grid h-full place-items-center text-xs text-subtle">
        还没有可展示的执行记录。
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      {canvasReady ? (
        <FlowErrorBoundary resetKey={`${rootOrder.join(",")}:${nodes.length}`}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodeClick={(_, node) => {
              const runId = (node.data as FlowCardData).runId;
              if (runId) onSelectRun(runId);
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.3 }}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
          </ReactFlow>
        </FlowErrorBoundary>
      ) : null}
    </div>
  );
}
