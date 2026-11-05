import type { Edge, Node } from "@xyflow/react";
import type { RunNode, Step } from "@agentdesk/shared";

export const COLUMN_WIDTH = 250;
export const ROW_HEIGHT = 118;

export type FlowCardKind = "run" | "tool" | "route" | "approval" | "note" | "delegate";

export interface FlowCardData extends Record<string, unknown> {
  kind: FlowCardKind;
  runId: string;
  agent?: string;
  title: string;
  subtitle: string;
  detail: string;
  status: "queued" | "running" | "done" | "error" | "waiting" | "rejected";
  stepIndex?: number;
}

export type FlowCardNode = Node<FlowCardData, "card">;

export interface FlowEdgeData extends Record<string, unknown> {
  live: boolean;
}

function stepStatus(step: Step, run: RunNode): FlowCardData["status"] {
  if (step.kind === "tool") {
    if (!step.done) return run.done ? "error" : "running";
    return step.isError ? "error" : "done";
  }
  if (step.kind === "approval") {
    if (!step.resolved) return "waiting";
    return step.approved ? "done" : "rejected";
  }
  if (step.kind === "delegate") return run.done ? "done" : "running";
  return run.done ? "done" : "running";
}

function stepArgHint(args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const value = record.path ?? record.command ?? record.query ?? record.task ?? record.project;
  return typeof value === "string" ? value : "";
}

export function buildFlowGraph(
  runsById: Record<string, RunNode>,
  rootOrder: string[],
  selectedRunId: string | null,
  labels: {
    agentLabel: (agent: string) => string;
    toolLabel: (name: string) => string;
  },
): { nodes: FlowCardNode[]; edges: Edge<FlowEdgeData>[] } {
  const positions = new Map<string, { x: number; y: number }>();
  const nodes: FlowCardNode[] = [];
  const edges: Edge<FlowEdgeData>[] = [];
  const placed = new Set<string>();

  const pushNode = (node: FlowCardNode, x: number, y: number) => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    positions.set(node.id, { x, y });
    nodes.push({ ...node, position: { x, y } });
  };

  const pushEdge = (source: string, target: string, live: boolean) => {
    const id = `${source}->${target}`;
    if (edges.some((e) => e.id === id)) return;
    edges.push({
      id,
      source,
      target,
      type: "fluid",
      data: { live },
      style: { strokeWidth: 1.6 },
    });
  };

  /** 布局一棵 Run：返回末节点 id 与占用的最大列下标。 */
  const layoutRun = (
    runId: string,
    col: number,
    row: number,
  ): { lastId: string; endCol: number; row: number } => {
    const run = runsById[runId];
    if (!run) return { lastId: `run:${runId}`, endCol: col, row };

    const runNodeId = `run:${runId}`;
    const runLive = run.runStatus === "running";
    pushNode(
      {
        id: runNodeId,
        type: "card",
        position: { x: 0, y: 0 },
        data: {
          kind: "run",
          runId,
          agent: run.agent,
          title: labels.agentLabel(run.agent),
          subtitle: run.parentRunId ? "委派任务" : "总控",
          detail: run.trigger,
          status:
            run.runStatus === "failed"
              ? "error"
              : run.runStatus === "running"
                ? "running"
                : run.runStatus === "queued"
                  ? "queued"
                  : "done",
        },
        selected: runId === selectedRunId,
      },
      col * COLUMN_WIDTH,
      row * ROW_HEIGHT,
    );

    let prevId = runNodeId;
    let nextCol = col + 1;
    let cursorRow = row;

    run.steps.forEach((step, index) => {
      if (step.kind === "delegate") {
        const child = runsById[step.runId];
        const childLive = child?.runStatus === "running";
        pushEdge(prevId, `run:${step.runId}`, runLive || Boolean(childLive));
        const nested = layoutRun(step.runId, nextCol, cursorRow);
        prevId = nested.lastId;
        nextCol = nested.endCol;
        cursorRow = nested.row;
        return;
      }

      const stepId = `step:${runId}:${index}`;
      let title = "";
      let subtitle = "";
      let detail = "";
      let status = stepStatus(step, run);

      if (step.kind === "tool") {
        title = labels.toolLabel(step.name);
        subtitle = "工具";
        detail = stepArgHint(step.args);
      } else if (step.kind === "route") {
        title = labels.agentLabel(step.agent);
        subtitle = "路由";
        detail = step.reason;
      } else if (step.kind === "approval") {
        title = step.title;
        subtitle = "审批";
        detail = step.resolved ? (step.approved ? "已批准，继续执行" : "已拒绝") : "等待确认";
        status = stepStatus(step, run);
      } else if (step.kind === "note") {
        title = "自动放行";
        subtitle = step.source === "classifier" ? "分类器" : "规则";
        detail = step.text;
      }

      const live = status === "running" || status === "waiting";
      pushNode(
        {
          id: stepId,
          type: "card",
          position: { x: 0, y: 0 },
          data: {
            kind: step.kind,
            runId,
            title,
            subtitle,
            detail,
            status,
            stepIndex: index,
          },
          selected: runId === selectedRunId,
        },
        nextCol * COLUMN_WIDTH,
        cursorRow * ROW_HEIGHT,
      );
      pushEdge(prevId, stepId, live || runLive);
      prevId = stepId;
      nextCol += 1;
    });

    return { lastId: prevId, endCol: nextCol, row: cursorRow };
  };

  let row = 0;
  for (const rootId of rootOrder) {
    if (!runsById[rootId]) continue;
    layoutRun(rootId, 0, row);
    row += 1;
  }

  // 未被 rootOrder 覆盖但仍存在的孤儿 run（防御）
  for (const runId of Object.keys(runsById)) {
    if (!placed.has(`run:${runId}`)) {
      layoutRun(runId, 0, row);
      row += 1;
    }
  }

  return { nodes, edges };
}
