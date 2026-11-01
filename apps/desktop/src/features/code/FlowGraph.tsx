import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
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
import type { RunNode, Step } from "@agentdesk/shared";
import { Button, cn } from "@agentdesk/ui";
import { AGENT_META, TOOL_LABELS } from "../../lib/agents";

const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 110;

type DisplayStatus = RunNode["runStatus"] | "awaiting-approval";

const STATUS_RING: Record<DisplayStatus, string> = {
  queued: "",
  running: "ring-2 ring-info shadow-[0_0_24px_-4px_var(--ad-info)]",
  succeeded: "ring-2 ring-success/70",
  failed: "ring-2 ring-danger",
  cancelled: "opacity-60",
  "awaiting-approval": "ring-2 ring-warning shadow-[0_0_24px_-4px_var(--ad-warning)]",
};

function displayStatus(run: RunNode): DisplayStatus {
  if (!run.done && run.steps.some((step) => step.kind === "approval" && !step.resolved))
    return "awaiting-approval";
  return run.runStatus;
}

function stepArgHint(args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const value = record.path ?? record.command ?? record.query ?? record.task ?? record.project;
  return typeof value === "string" ? value : "";
}

/** 没有真实思维链时，用最近一步结构化信息拼出"正在做什么"的一句话摘要。 */
function actionSummary(run: RunNode): string {
  const last: Step | undefined = run.steps.at(-1);
  if (!last) return run.done ? "" : "正在理解任务、读取项目上下文…";
  if (last.kind === "tool") {
    const label = TOOL_LABELS[last.name] ?? last.name;
    const hint = stepArgHint(last.args);
    return hint ? `${label} · ${hint}` : label;
  }
  if (last.kind === "approval")
    return last.resolved
      ? last.approved
        ? "已批准，继续执行"
        : "已拒绝"
      : `等待审批：${last.title}`;
  if (last.kind === "route") return `委派理由：${last.reason}`;
  if (last.kind === "delegate")
    return `委派给 ${AGENT_META[last.agent]?.label ?? last.agent} Agent`;
  if (last.kind === "note") return last.text;
  return "";
}

export interface FlowRunData extends Record<string, unknown> {
  run: RunNode;
}
type FlowRunNode = Node<FlowRunData, "run">;

const FlowRunNodeView = memo(function FlowRunNodeView({ data, selected }: NodeProps<FlowRunNode>) {
  const { run } = data;
  const meta = AGENT_META[run.agent];
  const Icon = meta?.icon;
  const status = displayStatus(run);
  const text = actionSummary(run);
  return (
    <div
      className={cn(
        "w-[220px] rounded-2xl border bg-surface shadow-lg transition-shadow",
        selected ? "border-fg/40" : "border-border",
        STATUS_RING[status],
      )}
    >
      {run.parentRunId ? (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-subtle"
        />
      ) : null}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="grid h-6 w-6 place-items-center rounded-lg bg-brand/15 text-brand">
          {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-semibold">{meta?.label ?? run.agent}</p>
          <p className="text-[10.5px] text-subtle">
            {run.parentRunId ? "委派任务" : "总控"} · {run.trigger}
          </p>
        </div>
      </div>
      {text ? (
        <p className="mx-3 mb-2.5 line-clamp-2 rounded-lg bg-surface-2 px-2 py-1 font-mono text-[10.5px] text-muted">
          {text}
        </p>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-brand"
      />
    </div>
  );
});

const nodeTypes = { run: FlowRunNodeView };

/** React19 + xyflow 偶发 panZoom 清理异常时，吞掉错误并允许重挂载画布（照搬工作流编辑器的处理）。 */
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

/** 按委派顺序（parentRunId -> 子 Run.steps 里的 DelegateStep）做简单的递归树布局，不需要自动布局库。 */
function layoutTree(runsById: Record<string, RunNode>, rootOrder: string[]) {
  const childrenOf = (runId: string): string[] =>
    (runsById[runId]?.steps ?? [])
      .filter((step): step is Extract<Step, { kind: "delegate" }> => step.kind === "delegate")
      .map((step) => step.runId)
      .filter((childId) => runsById[childId] !== undefined);

  const positions = new Map<string, { x: number; y: number }>();
  let leafCount = 0;
  const place = (runId: string, depth: number): number => {
    const children = childrenOf(runId);
    const y =
      children.length === 0
        ? leafCount++ * ROW_HEIGHT
        : children.reduce((sum, childId) => sum + place(childId, depth + 1), 0) / children.length;
    positions.set(runId, { x: depth * COLUMN_WIDTH, y });
    return y;
  };
  for (const rootId of rootOrder) place(rootId, 0);
  return positions;
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
  const { nodes, edges } = useMemo(() => {
    const positions = layoutTree(runsById, rootOrder);
    const nodeList: FlowRunNode[] = Object.values(runsById).map((run) => ({
      id: run.runId,
      type: "run",
      position: positions.get(run.runId) ?? { x: 0, y: 0 },
      data: { run },
      selected: run.runId === selectedRunId,
    }));
    const edgeList: Edge[] = Object.values(runsById)
      .filter((run) => run.parentRunId && runsById[run.parentRunId])
      .map((run) => ({
        id: `${run.parentRunId}->${run.runId}`,
        source: run.parentRunId as string,
        target: run.runId,
        animated: run.runStatus === "running",
        style: { strokeWidth: 1.6 },
      }));
    return { nodes: nodeList, edges: edgeList };
  }, [runsById, rootOrder, selectedRunId]);

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
        <FlowErrorBoundary resetKey={rootOrder.join(",")}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => onSelectRun(node.id)}
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
