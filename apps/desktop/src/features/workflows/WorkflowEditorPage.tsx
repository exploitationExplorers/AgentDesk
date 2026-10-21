import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from "@xyflow/react";
import { ArrowLeft, Check, Play, Save, Square, Terminal } from "lucide-react";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  NODE_SPECS,
  type NodeRunStatus,
  type NodeType,
  type Workflow,
  type WorkflowRunEvent,
} from "@agentdesk/workflow/dsl";
import { Badge, Button, Dialog, Field, Input, Spinner, cn } from "@agentdesk/ui";
import { BrowserLivePanel } from "../../components/BrowserLivePanel";
import { TOOL_LABELS } from "../../lib/agents";
import { api } from "../../lib/api";
import { subscribe } from "../../lib/http";
import { workflowEditorRoute } from "../../router";
import { useUi } from "../../stores/ui";
import { NodeConfigPanel, WorkflowMetaPanel, type WorkflowMeta } from "./ConfigPanel";
import { FlowNodeView, type FlowNode } from "./FlowNode";
import { NODE_COLOR, NODE_ICON, handleLabel } from "./nodeMeta";

const nodeTypes = { wf: FlowNodeView };
const PALETTE_GROUPS = ["基础", "AI", "逻辑", "集成"];

/** React19 + xyflow 偶发 panZoom 清理异常时，整页 Error Overlay；这里吞掉并重挂载画布 */
class FlowErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null; generation: number }
> {
  state = { error: null as Error | null, generation: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[workflow-flow]", error.message, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, generation: this.state.generation + 1 });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid h-full place-items-center gap-3 p-6 text-center">
          <p className="text-[13px] text-danger">画布渲染异常：{this.state.error.message}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => this.setState((s) => ({ error: null, generation: s.generation + 1 }))}
          >
            重新加载画布
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

function toFlow(wf: Workflow): { nodes: FlowNode[]; edges: Edge[] } {
  const kindOf = new Map(wf.nodes.map((n) => [n.id, n.type]));
  return {
    nodes: wf.nodes.map((n) => ({
      id: n.id,
      type: "wf",
      position: n.position,
      data: { kind: n.type, label: n.data.label, config: n.data.config },
    })),
    edges: wf.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      label: handleLabel(kindOf.get(e.source), e.sourceHandle),
    })),
  };
}

interface LogLine {
  at: string;
  nodeId?: string;
  text: string;
  tone: "info" | "success" | "danger" | "muted";
}

function describeEvent(e: WorkflowRunEvent, labelOf: (id: string) => string): LogLine | null {
  const at = new Date().toLocaleTimeString();
  switch (e.type) {
    case "run_start":
      return { at, text: "开始运行", tone: "info" };
    case "node_start":
      return {
        at,
        nodeId: e.nodeId,
        text: `▶ ${labelOf(e.nodeId)}${e.iteration !== undefined ? ` #${e.iteration + 1}` : ""}`,
        tone: "muted",
      };
    case "node_log": {
      const msg = e.message.replace(
        /^调用工具 ([\w.]+)/,
        (_m, name: string) => `调用工具 ${TOOL_LABELS[name] ?? name}`,
      );
      const tone =
        msg.includes("[git]") || msg.includes("[Claude]") || msg.includes("[claude.run]")
          ? "info"
          : "muted";
      return { at, nodeId: e.nodeId, text: `  ${msg}`, tone };
    }
    case "node_end": {
      const out = typeof e.output === "string" ? e.output : JSON.stringify(e.output);
      return {
        at,
        nodeId: e.nodeId,
        text: `✓ ${labelOf(e.nodeId)}  ${(out ?? "").slice(0, 300)}`,
        tone: "success",
      };
    }
    case "node_error":
      return { at, nodeId: e.nodeId, text: `✗ ${labelOf(e.nodeId)}：${e.error}`, tone: "danger" };
    case "node_skip":
      return null;
    case "run_end":
      return {
        at,
        text:
          e.status === "succeeded"
            ? "运行成功"
            : e.status === "cancelled"
              ? "已取消"
              : `运行失败：${e.error ?? ""}`,
        tone: e.status === "succeeded" ? "success" : "danger",
      };
  }
}

function Editor({ workflow }: { workflow: Workflow }) {
  const queryClient = useQueryClient();
  const flow = useReactFlow();
  const initial = useMemo(() => toFlow(workflow), [workflow]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [meta, setMeta] = useState<WorkflowMeta>({
    name: workflow.name,
    description: workflow.description,
    trigger: workflow.trigger,
    inputs: workflow.inputs,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [askInputs, setAskInputs] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const consoleEnd = useRef<HTMLDivElement>(null);
  const openBrowserPanel = useUi((s) => s.openBrowserPanel);
  const closeBrowserPanel = useUi((s) => s.closeBrowserPanel);
  const browserPanelOpen = useUi((s) => s.browserPanelOpen);
  const activeBrowserSessionId = useUi((s) => s.activeBrowserSessionId);

  /** 底部日志/实况栏高度（可拖），默认 208px ≈ h-52 */
  const [dockH, setDockH] = useState(() => {
    try {
      const n = Number(localStorage.getItem("wf-dock-h"));
      if (Number.isFinite(n) && n >= 120 && n <= 560) return n;
    } catch {
      /* ignore */
    }
    return 208;
  });
  const dockHRef = useRef(dockH);
  dockHRef.current = dockH;
  const dragDock = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragDock.current;
      if (!d) return;
      const next = Math.min(560, Math.max(120, d.startH + (d.startY - e.clientY)));
      dockHRef.current = next;
      setDockH(next);
    };
    const onUp = () => {
      if (!dragDock.current) return;
      dragDock.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem("wf-dock-h", String(dockHRef.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const markDirty = () => setDirty(true);

  /**
   * 延迟两帧再挂载画布：父容器需先完成 flex 布局，
   * 否则 React19 + xyflow ZoomPane 首帧 panZoom 清理会抛 destroy is not a function。
   */
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

  // 进入编辑器时关掉残留实况面板，避免错误 session 干扰
  useEffect(() => {
    closeBrowserPanel();
    // 仅随工作流 id 清理一次
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意不依赖 closeBrowserPanel 引用
  }, [workflow.id]);

  /** 工作流跑着时轮询浏览器会话；延迟挂面板，避免与画布同帧抢布局 */
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let openTimer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void api
        .browserSessions()
        .then((list) => {
          const id = list[0]?.id;
          if (cancelled || !id) return;
          window.clearTimeout(openTimer);
          openTimer = setTimeout(() => {
            if (!cancelled) openBrowserPanel(id);
          }, 120);
        })
        .catch(() => {
          /* sidecar 未就绪时忽略 */
        });
    };
    tick();
    const t = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.clearTimeout(openTimer);
    };
  }, [running, openBrowserPanel]);

  const defaultEdgeOptions = useMemo(
    () => ({ animated: running, style: { strokeWidth: 1.6 } }),
    [running],
  );

  const setStatuses = useCallback(
    (
      update: (
        prev: Record<string, NodeRunStatus | undefined>,
      ) => Record<string, NodeRunStatus | undefined>,
    ) => {
      setNodes((ns) => {
        const prev = Object.fromEntries(ns.map((n) => [n.id, n.data.status]));
        const next = update(prev);
        return ns.map((n) =>
          next[n.id] === n.data.status ? n : { ...n, data: { ...n.data, status: next[n.id] } },
        );
      });
    },
    [setNodes],
  );

  const flowRef = useRef(flow);
  flowRef.current = flow;

  useEffect(() => {
    if (!runId) return;
    const labelOf = (id: string) =>
      (flowRef.current.getNode(id)?.data.label as string | undefined) ?? id;
    return subscribe<WorkflowRunEvent>(
      `/workflow-runs/${runId}/events`,
      (e) => {
        const line = describeEvent(e, labelOf);
        if (line) setLogs((l) => [...l.slice(-400), line]);
        if (e.type === "node_start") setStatuses((s) => ({ ...s, [e.nodeId]: "running" }));
        if (e.type === "node_end") setStatuses((s) => ({ ...s, [e.nodeId]: "succeeded" }));
        if (e.type === "node_error") setStatuses((s) => ({ ...s, [e.nodeId]: "failed" }));
        if (e.type === "node_skip") setStatuses((s) => ({ ...s, [e.nodeId]: "skipped" }));
        if (e.type === "run_end") {
          setRunning(false);
          void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
        }
      },
      { isFinal: (e) => e.type === "run_end" },
    );
  }, [runId, setStatuses, queryClient]);

  useEffect(() => {
    consoleEnd.current?.scrollIntoView({ block: "end" });
  }, [logs.length]);

  const serialize = () => ({
    ...meta,
    nodes: flow.getNodes().map((n) => {
      const d = n.data as FlowNode["data"];
      return {
        id: n.id,
        type: d.kind,
        position: n.position,
        data: { label: d.label, config: d.config },
      };
    }),
    edges: flow.getEdges().map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
    })),
  });

  const save = useMutation({
    mutationFn: () => api.saveWorkflow(serialize(), workflow.id),
    onSuccess: (wf) => {
      setDirty(false);
      queryClient.setQueryData(["workflow", workflow.id], wf);
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });

  const run = useMutation({
    mutationFn: async (inputs: Record<string, string>) => {
      if (dirty) await save.mutateAsync();
      return api.runWorkflow(workflow.id, inputs);
    },
    onMutate: () => {
      setLogs([]);
      setStatuses(() => ({}));
      setRunning(true);
    },
    onSuccess: (r) => setRunId(r.id),
    onError: (error) => {
      setRunning(false);
      setLogs([{ at: new Date().toLocaleTimeString(), text: error.message, tone: "danger" }]);
    },
  });
  const cancel = useMutation({ mutationFn: () => api.cancelWorkflowRun(runId!) });

  const startRun = () => {
    if (meta.inputs.length) {
      setInputValues(
        Object.fromEntries(meta.inputs.map((i) => [i.name, inputValues[i.name] ?? i.default])),
      );
      setAskInputs(true);
    } else run.mutate({});
  };

  const onConnect = useCallback(
    (c: Connection) => {
      const sourceKind = (flow.getNode(c.source)?.data as FlowNode["data"] | undefined)?.kind;
      setEdges((es) =>
        addEdge(
          {
            ...c,
            id: `e_${Date.now().toString(36)}`,
            label: handleLabel(sourceKind, c.sourceHandle),
          },
          es,
        ),
      );
      markDirty();
    },
    [flow, setEdges],
  );

  const addNode = (kind: NodeType) => {
    const id = `${kind}_${Math.random().toString(36).slice(2, 7)}`;
    const center = flow.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    const node: FlowNode = {
      id,
      type: "wf",
      position: {
        x: center.x - 105 + (Math.random() - 0.5) * 60,
        y: center.y - 40 + (Math.random() - 0.5) * 60,
      },
      data: { kind, label: NODE_SPECS[kind].title, config: {} },
    };
    setNodes((ns) => [...ns, node]);
    setSelectedId(id);
    markDirty();
  };

  const updateNode = (id: string, patch: Partial<FlowNode["data"]>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  };
  const deleteNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
    markDirty();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <Button size="icon" variant="ghost" asChild>
          <Link to="/workflows" aria-label="返回">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <input
          value={meta.name}
          onChange={(e) => {
            setMeta({ ...meta, name: e.target.value });
            markDirty();
          }}
          className="w-72 rounded-lg bg-transparent px-2 py-1 text-[15px] font-semibold outline-none hover:bg-surface-2 focus:bg-surface-2"
        />
        <Badge>v{workflow.version}</Badge>
        {dirty ? (
          <span className="text-[12px] text-subtle">未保存</span>
        ) : (
          <Check className="h-3.5 w-3.5 text-success" />
        )}
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            loading={save.isPending}
            onClick={() => save.mutate()}
            disabled={!dirty}
          >
            <Save className="h-3.5 w-3.5" />
            保存
          </Button>
          {running ? (
            <Button variant="danger" onClick={() => cancel.mutate()} disabled={!runId}>
              <Square className="h-3 w-3 fill-current" />
              停止
            </Button>
          ) : (
            <Button variant="primary" loading={run.isPending} onClick={startRun}>
              <Play className="h-3 w-3 fill-current" />
              运行
            </Button>
          )}
        </div>
      </div>
      {save.error ? (
        <div className="border-b bg-danger/10 px-4 py-2 text-[12.5px] text-danger">
          {save.error.message}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="w-[188px] shrink-0 overflow-y-auto border-r p-3">
          {PALETTE_GROUPS.map((group) => (
            <div key={group} className="mb-4">
              <p className="mb-1.5 px-1 text-[11px] font-medium text-subtle">{group}</p>
              {(Object.keys(NODE_SPECS) as NodeType[])
                .filter((k) => NODE_SPECS[k].group === group && k !== "start")
                .map((kind) => {
                  const Icon = NODE_ICON[kind];
                  const color = NODE_COLOR[group];
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => addNode(kind)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg"
                    >
                      <span
                        className="grid h-5 w-5 place-items-center rounded-md"
                        style={{ background: `${color}22`, color }}
                      >
                        <Icon className="h-3 w-3" />
                      </span>
                      {NODE_SPECS[kind].title}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>

        <div className="relative min-h-0 min-w-0 flex-1">
          {/*
            日志/实况用绝对定位叠在画布上，避免运行时突然插入底部栏改变
            ReactFlow 容器高度，从而触发 xyflow panZoom destroy 竞态。
          */}
          <div className="absolute inset-0">
            {canvasReady ? (
              <FlowErrorBoundary resetKey={workflow.id}>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={(changes) => {
                    onNodesChange(changes);
                    if (
                      changes.some((c) => c.type === "position" && c.dragging === false) ||
                      changes.some((c) => c.type === "remove")
                    )
                      markDirty();
                  }}
                  onEdgesChange={(changes) => {
                    onEdgesChange(changes);
                    if (changes.some((c) => c.type === "remove")) markDirty();
                  }}
                  onConnect={onConnect}
                  onNodeClick={(_, n) => setSelectedId(n.id)}
                  onPaneClick={() => setSelectedId(null)}
                  deleteKeyCode={["Delete", "Backspace"]}
                  defaultEdgeOptions={defaultEdgeOptions}
                  fitView
                  fitViewOptions={{ padding: 0.25 }}
                  proOptions={{ hideAttribution: true }}
                  colorMode="dark"
                >
                  <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
                </ReactFlow>
              </FlowErrorBoundary>
            ) : (
              <div className="grid h-full place-items-center">
                <Spinner />
              </div>
            )}
          </div>
          {logs.length || (browserPanelOpen && activeBrowserSessionId) ? (
            <div
              className="absolute inset-x-0 bottom-0 z-10 flex flex-col border-t bg-bg/95 backdrop-blur-sm"
              style={{ height: dockH }}
            >
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="拖动调整日志高度"
                title="上下拖动调整高度"
                className="group flex h-2 shrink-0 cursor-ns-resize items-center justify-center hover:bg-surface-2"
                onPointerDown={(e) => {
                  e.preventDefault();
                  dragDock.current = { startY: e.clientY, startH: dockHRef.current };
                  document.body.style.cursor = "ns-resize";
                  document.body.style.userSelect = "none";
                }}
              >
                <span className="h-0.5 w-10 rounded-full bg-border group-hover:bg-muted" />
              </div>
              <div className="flex min-h-0 flex-1">
                {logs.length ? (
                  <div className="min-w-0 flex-1 overflow-y-auto bg-surface/60 px-4 py-2 font-mono text-[11.5px] leading-5">
                    <div className="mb-1 flex items-center gap-1.5 font-sans text-[11.5px] font-medium text-subtle">
                      <Terminal className="h-3.5 w-3.5" />
                      运行日志
                      {running ? (
                        <>
                          <Spinner className="h-3 w-3" />
                          <span className="font-normal text-muted">
                            Claude 改代码时会出现 [Claude]/[git] 行
                          </span>
                        </>
                      ) : null}
                    </div>
                    {logs.map((l, i) => (
                      <div
                        key={i}
                        className={cn(
                          "cursor-default whitespace-pre-wrap",
                          {
                            info: "text-info",
                            success: "text-success",
                            danger: "text-danger",
                            muted: "text-muted",
                          }[l.tone],
                        )}
                        onClick={() => l.nodeId && setSelectedId(l.nodeId)}
                      >
                        <span className="mr-2 text-subtle">{l.at}</span>
                        {l.text}
                      </div>
                    ))}
                    <div ref={consoleEnd} />
                  </div>
                ) : null}
                {browserPanelOpen && activeBrowserSessionId ? (
                  <BrowserLivePanel
                    sessionId={activeBrowserSessionId}
                    compact
                    className="w-[340px] shrink-0 border-l"
                  />
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="w-[300px] shrink-0 overflow-y-auto border-l p-4">
          {selected ? (
            <NodeConfigPanel
              key={selected.id}
              node={selected}
              onChange={(patch) => updateNode(selected.id, patch)}
              onDelete={() => deleteNode(selected.id)}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <WorkflowMetaPanel
              meta={meta}
              onChange={(m) => {
                setMeta(m);
                markDirty();
              }}
            />
          )}
        </div>
      </div>

      <Dialog
        open={askInputs}
        onOpenChange={setAskInputs}
        title="运行参数"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setAskInputs(false);
              run.mutate(inputValues);
            }}
          >
            <Play className="h-3 w-3 fill-current" />
            开始运行
          </Button>
        }
      >
        <div className="grid gap-3">
          {meta.inputs.map((i) => (
            <Field key={i.name} label={i.label || i.name}>
              <Input
                value={inputValues[i.name] ?? ""}
                onChange={(e) => setInputValues({ ...inputValues, [i.name]: e.target.value })}
              />
            </Field>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

export function WorkflowEditorPage() {
  const { id } = workflowEditorRoute.useParams();
  const { data, error } = useQuery({
    queryKey: ["workflow", id],
    queryFn: () => api.workflow(id),
    staleTime: Infinity,
  });
  if (error) return <p className="p-8 text-[13px] text-danger">{error.message}</p>;
  if (!data) return <Spinner className="m-8" />;
  return (
    <ReactFlowProvider>
      <Editor key={data.id} workflow={data} />
    </ReactFlowProvider>
  );
}
