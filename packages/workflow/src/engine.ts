import type { NodeType, Workflow, WorkflowEdge, WorkflowNode, WorkflowRunEvent } from "./dsl";
import {
  evaluateCondition,
  render,
  renderConfig,
  type ConditionOperator,
  type Scope,
} from "./template";

export interface NodeExecutionContext {
  node: WorkflowNode;
  /** 已完成变量插值的配置 */
  config: Record<string, unknown>;
  scope: Scope;
  signal: AbortSignal;
  log: (message: string) => void;
}

export type NodeHandler = (ctx: NodeExecutionContext) => Promise<unknown>;

export type NodeHandlers = Partial<Record<NodeType, NodeHandler>>;

export interface ExecuteOptions {
  runId: string;
  inputs: Record<string, string>;
  handlers: NodeHandlers;
  onEvent: (event: WorkflowRunEvent) => void;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  status: "succeeded" | "failed" | "cancelled";
  output: unknown;
  error?: string;
  outputs: Record<string, unknown>;
}

export class WorkflowValidationError extends Error {}

export function validateWorkflow(workflow: Pick<Workflow, "nodes" | "edges">): void {
  const starts = workflow.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) throw new WorkflowValidationError("工作流必须有且只有一个开始节点");
  const ids = new Set(workflow.nodes.map((n) => n.id));
  for (const edge of workflow.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new WorkflowValidationError(`连线 ${edge.id} 指向不存在的节点`);
    }
  }
  // 检测环：loop 的回边不允许，循环通过 loop 节点的 body 分支表达
  const adjacency = new Map<string, string[]>();
  for (const e of workflow.edges)
    adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target]);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): void => {
    if (state.get(id) === 1) throw new WorkflowValidationError("工作流存在环路");
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const next of adjacency.get(id) ?? []) visit(next);
    state.set(id, 2);
  };
  for (const id of ids) visit(id);
}

/** 从 handle 出发可达的节点集合 */
function reachable(fromIds: string[], edges: WorkflowEdge[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...fromIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.source === id) stack.push(e.target);
  }
  return seen;
}

/**
 * DAG 执行器：
 * - 节点在所有入边都"已决议"后执行；任一入边激活即运行，全部未激活则跳过（分支汇合语义）。
 * - condition 节点按结果激活 true/false 出边。
 * - loop 节点对 body 分支子图逐项执行，结果数组从 done 分支继续。
 */
export class WorkflowEngine {
  private readonly nodes: Map<string, WorkflowNode>;

  constructor(
    private readonly workflow: Pick<Workflow, "nodes" | "edges">,
    private readonly options: ExecuteOptions,
  ) {
    validateWorkflow(workflow);
    this.nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  }

  async execute(): Promise<ExecuteResult> {
    const controller = new AbortController();
    this.options.signal?.addEventListener("abort", () => controller.abort());
    const outputs: Record<string, unknown> = {};
    const scope: Scope = { inputs: this.options.inputs, nodes: {} };
    this.options.onEvent({ type: "run_start", runId: this.options.runId });

    const start = this.workflow.nodes.find((n) => n.type === "start")!;
    try {
      const final = await this.runSubgraph(
        [start.id],
        new Set(this.workflow.nodes.map((n) => n.id)),
        scope,
        outputs,
        controller.signal,
      );
      const endNode = this.workflow.nodes.find((n) => n.type === "end" && n.id in outputs);
      const output = endNode ? outputs[endNode.id] : final;
      this.options.onEvent({ type: "run_end", status: "succeeded", output });
      return { status: "succeeded", output, outputs };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      const status = cancelled ? "cancelled" : "failed";
      this.options.onEvent({ type: "run_end", status, output: null, error: message });
      return { status, output: null, error: message, outputs };
    }
  }

  private async runSubgraph(
    entryIds: string[],
    allowed: Set<string>,
    scope: Scope,
    outputs: Record<string, unknown>,
    signal: AbortSignal,
    iteration?: number,
  ): Promise<unknown> {
    const edges = this.workflow.edges.filter((e) => allowed.has(e.source) && allowed.has(e.target));
    const incoming = new Map<string, WorkflowEdge[]>();
    for (const e of edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e]);

    const edgeActive = new Map<string, boolean>();
    const done = new Set<string>();
    const pending = new Set(reachable(entryIds, edges));
    let lastOutput: unknown = null;

    while (pending.size > 0) {
      if (signal.aborted) throw new Error("工作流已取消");
      const ready = [...pending].filter((id) => {
        if (entryIds.includes(id)) return true;
        return (incoming.get(id) ?? []).every((e) => edgeActive.has(e.id));
      });
      if (ready.length === 0) throw new Error("工作流无法继续：存在未决议的依赖");

      await Promise.all(
        ready.map(async (id) => {
          pending.delete(id);
          const node = this.nodes.get(id)!;
          const inbound = incoming.get(id) ?? [];
          const activated = entryIds.includes(id) || inbound.some((e) => edgeActive.get(e.id));
          const outEdges = edges.filter((e) => e.source === id);

          if (!activated) {
            this.options.onEvent({ type: "node_skip", nodeId: id });
            for (const e of outEdges) edgeActive.set(e.id, false);
            done.add(id);
            return;
          }

          const result = await this.runNode(node, scope, outputs, signal, allowed, iteration);
          lastOutput = result.output;
          for (const e of outEdges) {
            edgeActive.set(
              e.id,
              result.activeHandles === null || result.activeHandles.includes(e.sourceHandle ?? ""),
            );
          }
          // loop 的 body 子图已在 runNode 内部执行，这里标记为已决议
          for (const id2 of result.consumed) {
            if (pending.delete(id2)) {
              for (const e of edges.filter((x) => x.source === id2)) edgeActive.set(e.id, false);
              done.add(id2);
            }
          }
          done.add(id);
        }),
      );
    }
    return lastOutput;
  }

  private async runNode(
    node: WorkflowNode,
    scope: Scope,
    outputs: Record<string, unknown>,
    signal: AbortSignal,
    allowed: Set<string>,
    iteration?: number,
  ): Promise<{ output: unknown; activeHandles: string[] | null; consumed: string[] }> {
    const emit = this.options.onEvent;
    emit({ type: "node_start", nodeId: node.id, iteration });
    const config = renderConfig(node.data.config, scope);
    const record = (output: unknown) => {
      outputs[node.id] = output;
      (scope.nodes as Record<string, unknown>)[node.id] = { output };
      emit({ type: "node_end", nodeId: node.id, output, iteration });
    };

    try {
      switch (node.type) {
        case "start":
          record(this.options.inputs);
          return { output: this.options.inputs, activeHandles: null, consumed: [] };
        case "end": {
          const output =
            "output" in node.data.config
              ? config.output
              : Object.fromEntries(
                  Object.entries(scope.nodes as Record<string, { output: unknown }>).map(
                    ([id, v]) => [id, v.output],
                  ),
                );
          record(output);
          return { output, activeHandles: null, consumed: [] };
        }
        case "text": {
          const output = config.template ?? "";
          record(output);
          return { output, activeHandles: null, consumed: [] };
        }
        case "condition": {
          const result = evaluateCondition(
            config.left,
            (config.operator as ConditionOperator) ?? "eq",
            config.right,
          );
          record(result);
          return { output: result, activeHandles: [result ? "true" : "false"], consumed: [] };
        }
        case "loop":
          return await this.runLoop(node, config, scope, outputs, signal, allowed, record);
        default: {
          const handler = this.options.handlers[node.type];
          if (!handler) throw new Error(`节点类型 ${node.type} 没有可用的执行器`);
          const output = await handler({
            node,
            config,
            scope,
            signal,
            log: (message) => emit({ type: "node_log", nodeId: node.id, message }),
          });
          record(output);
          return { output, activeHandles: null, consumed: [] };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "node_error", nodeId: node.id, error: message });
      throw new Error(`节点「${node.data.label}」失败：${message}`, { cause: error });
    }
  }

  private async runLoop(
    node: WorkflowNode,
    config: Record<string, unknown>,
    scope: Scope,
    outputs: Record<string, unknown>,
    signal: AbortSignal,
    allowed: Set<string>,
    record: (output: unknown) => void,
  ): Promise<{ output: unknown; activeHandles: string[]; consumed: string[] }> {
    let items: unknown = config.items;
    if (typeof items === "string") {
      const raw: string = items;
      try {
        items = JSON.parse(raw);
      } catch {
        items = raw.split("\n").filter(Boolean);
      }
    }
    if (!Array.isArray(items)) throw new Error("循环节点的 items 不是数组");
    const max = Number(config.maxIterations ?? 50) || 50;

    const edges = this.workflow.edges;
    const bodyEntries = edges
      .filter((e) => e.source === node.id && e.sourceHandle === "body")
      .map((e) => e.target);
    const doneEntries = edges
      .filter((e) => e.source === node.id && e.sourceHandle === "done")
      .map((e) => e.target);
    const afterDone = reachable(doneEntries, edges);
    const body = new Set(
      [...reachable(bodyEntries, edges)].filter((id) => !afterDone.has(id) && allowed.has(id)),
    );

    const results: unknown[] = [];
    for (const [index, item] of items.slice(0, max).entries()) {
      const iterScope: Scope = {
        ...scope,
        loop: { item, index },
        nodes: { ...(scope.nodes as object) },
      };
      const out = await this.runSubgraph(bodyEntries, body, iterScope, outputs, signal, index);
      results.push(out);
    }
    record(results);
    return { output: results, activeHandles: ["done"], consumed: [...body] };
  }
}

export async function executeWorkflow(
  workflow: Pick<Workflow, "nodes" | "edges">,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  return new WorkflowEngine(workflow, options).execute();
}

export { render };

/** 默认的 HTTP 节点执行器，可被宿主覆盖。 */
export const httpHandler: NodeHandler = async ({ config, signal }) => {
  const headers =
    typeof config.headers === "string" && config.headers.trim()
      ? JSON.parse(config.headers)
      : config.headers;
  const method = String(config.method ?? "GET");
  const response = await fetch(String(config.url), {
    method,
    headers: (headers as Record<string, string>) ?? undefined,
    body:
      method === "GET"
        ? undefined
        : typeof config.body === "string"
          ? config.body
          : JSON.stringify(config.body),
    signal,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON 响应保持文本
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { status: response.status, body };
};
