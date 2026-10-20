import { describe, expect, it } from "vitest";
import {
  WORKFLOW_TEMPLATES,
  WorkflowValidationError,
  executeWorkflow,
  render,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowRunEvent,
} from "../src";

const node = (
  id: string,
  type: WorkflowNode["type"],
  config: Record<string, unknown> = {},
): WorkflowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
});
const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => ({
  id: `${source}-${target}-${sourceHandle ?? ""}`,
  source,
  target,
  sourceHandle,
});

describe("template", () => {
  it("单变量保留原始类型，多变量拼接字符串", () => {
    const scope = { inputs: { list: [1, 2], name: "bot" } };
    expect(render("{{inputs.list}}", scope)).toEqual([1, 2]);
    expect(render("hi {{inputs.name}}", scope)).toBe("hi bot");
  });
});

describe("engine", () => {
  it("线性流程传递变量", async () => {
    const result = await executeWorkflow(
      {
        nodes: [
          node("s", "start"),
          node("t", "text", { template: "hello {{inputs.name}}" }),
          node("e", "end", { output: "{{nodes.t.output}}!" }),
        ],
        edges: [edge("s", "t"), edge("t", "e")],
      },
      { runId: "r1", inputs: { name: "world" }, handlers: {}, onEvent: () => {} },
    );
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("hello world!");
  });

  it("条件分支只执行命中的一侧，汇合节点照常执行", async () => {
    const events: WorkflowRunEvent[] = [];
    const result = await executeWorkflow(
      {
        nodes: [
          node("s", "start"),
          node("c", "condition", { left: "{{inputs.env}}", operator: "eq", right: "prod" }),
          node("yes", "text", { template: "prod" }),
          node("no", "text", { template: "dev" }),
          node("e", "end", { output: "{{nodes.yes.output}}{{nodes.no.output}}" }),
        ],
        edges: [
          edge("s", "c"),
          edge("c", "yes", "true"),
          edge("c", "no", "false"),
          edge("yes", "e"),
          edge("no", "e"),
        ],
      },
      { runId: "r2", inputs: { env: "prod" }, handlers: {}, onEvent: (e) => events.push(e) },
    );
    expect(result.output).toBe("prod");
    expect(events).toContainEqual({ type: "node_skip", nodeId: "no" });
  });

  it("循环节点对每一项执行 body 子图", async () => {
    const result = await executeWorkflow(
      {
        nodes: [
          node("s", "start"),
          node("l", "loop", { items: '["a","b","c"]' }),
          node("b", "text", { template: "{{loop.index}}:{{loop.item}}" }),
          node("e", "end", { output: "{{nodes.l.output}}" }),
        ],
        edges: [edge("s", "l"), edge("l", "b", "body"), edge("l", "e", "done")],
      },
      { runId: "r3", inputs: {}, handlers: {}, onEvent: () => {} },
    );
    expect(result.output).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("节点失败时整体失败并给出节点名", async () => {
    const result = await executeWorkflow(
      {
        nodes: [node("s", "start"), node("x", "shell", { command: "boom" })],
        edges: [edge("s", "x")],
      },
      {
        runId: "r4",
        inputs: {},
        handlers: { shell: async () => Promise.reject(new Error("exit 1")) },
        onEvent: () => {},
      },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("x");
  });

  it("拒绝环路", async () => {
    await expect(
      executeWorkflow(
        {
          nodes: [node("s", "start"), node("a", "text"), node("b", "text")],
          edges: [edge("s", "a"), edge("a", "b"), edge("b", "a")],
        },
        { runId: "r5", inputs: {}, handlers: {}, onEvent: () => {} },
      ),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it("内置模板结构合法", async () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const wf = template.build();
      expect(wf.nodes.filter((n) => n.type === "start")).toHaveLength(1);
    }
  });
});
