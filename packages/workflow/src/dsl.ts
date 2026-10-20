import { z } from "zod";

export const NodeType = z.enum([
  "start",
  "end",
  "llm",
  "agent",
  "tool",
  "condition",
  "loop",
  "http",
  "shell",
  "git",
  "deploy",
  "approval",
  "notify",
  "text",
]);
export type NodeType = z.infer<typeof NodeType>;

export const WorkflowNode = z.object({
  id: z.string(),
  type: NodeType,
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    label: z.string(),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  /** condition: "true" | "false"；loop: "body" | "done" */
  sourceHandle: z.string().nullish(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const WorkflowTrigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({ type: z.literal("schedule"), time: z.string().regex(/^\d{2}:\d{2}$/) }),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

export const WorkflowInputDef = z.object({
  name: z.string(),
  label: z.string(),
  default: z.string().default(""),
});

export const Workflow = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.number().int().default(1),
  trigger: WorkflowTrigger.default({ type: "manual" }),
  inputs: z.array(WorkflowInputDef).default([]),
  nodes: z.array(WorkflowNode),
  edges: z.array(WorkflowEdge),
  updatedAt: z.string(),
});
export type Workflow = z.infer<typeof Workflow>;

export const WorkflowInput = Workflow.omit({ id: true, updatedAt: true, version: true });
export type WorkflowInput = z.infer<typeof WorkflowInput>;

export type NodeRunStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type WorkflowRunEvent =
  | { type: "run_start"; runId: string }
  | { type: "node_start"; nodeId: string; iteration?: number }
  | { type: "node_log"; nodeId: string; message: string }
  | { type: "node_end"; nodeId: string; output: unknown; iteration?: number }
  | { type: "node_error"; nodeId: string; error: string }
  | { type: "node_skip"; nodeId: string }
  | {
      type: "run_end";
      status: "succeeded" | "failed" | "cancelled";
      output: unknown;
      error?: string;
    };

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  inputs: Record<string, string>;
  nodeStates: Record<string, { status: NodeRunStatus; output?: unknown; error?: string }>;
  output: unknown;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** 节点面板元数据：画布、配置表单和校验共用。 */
export interface NodeFieldSpec {
  key: string;
  label: string;
  kind: "text" | "textarea" | "select" | "number";
  options?: string[];
  placeholder?: string;
}

export const NODE_SPECS: Record<
  NodeType,
  { title: string; group: string; fields: NodeFieldSpec[] }
> = {
  start: { title: "开始", group: "基础", fields: [] },
  end: {
    title: "结束",
    group: "基础",
    fields: [{ key: "output", label: "输出（支持 {{变量}}）", kind: "textarea" }],
  },
  text: {
    title: "文本模板",
    group: "基础",
    fields: [
      { key: "template", label: "模板", kind: "textarea", placeholder: "你好 {{inputs.name}}" },
    ],
  },
  llm: {
    title: "大模型",
    group: "AI",
    fields: [
      { key: "system", label: "系统提示", kind: "textarea" },
      { key: "prompt", label: "用户提示", kind: "textarea" },
    ],
  },
  agent: {
    title: "Agent",
    group: "AI",
    fields: [
      {
        key: "agent",
        label: "Agent",
        kind: "select",
        options: ["orchestrator", "project", "deploy", "research", "code"],
      },
      { key: "task", label: "任务", kind: "textarea" },
    ],
  },
  tool: {
    title: "工具",
    group: "AI",
    fields: [
      { key: "tool", label: "工具名", kind: "text", placeholder: "feed.today" },
      { key: "args", label: "参数 JSON", kind: "textarea", placeholder: "{}" },
    ],
  },
  condition: {
    title: "条件分支",
    group: "逻辑",
    fields: [
      { key: "left", label: "左值", kind: "text" },
      {
        key: "operator",
        label: "运算符",
        kind: "select",
        options: ["eq", "neq", "contains", "gt", "lt", "empty", "notEmpty"],
      },
      { key: "right", label: "右值", kind: "text" },
    ],
  },
  loop: {
    title: "循环",
    group: "逻辑",
    fields: [
      {
        key: "items",
        label: "数组（变量或 JSON）",
        kind: "text",
        placeholder: "{{nodes.n1.output}}",
      },
      { key: "maxIterations", label: "最大次数", kind: "number" },
    ],
  },
  approval: {
    title: "人工审批",
    group: "逻辑",
    fields: [
      { key: "title", label: "标题", kind: "text" },
      { key: "detail", label: "说明", kind: "textarea" },
    ],
  },
  http: {
    title: "HTTP 请求",
    group: "集成",
    fields: [
      { key: "method", label: "方法", kind: "select", options: ["GET", "POST", "PUT", "DELETE"] },
      { key: "url", label: "URL", kind: "text" },
      { key: "headers", label: "Headers JSON", kind: "textarea" },
      { key: "body", label: "Body", kind: "textarea" },
    ],
  },
  shell: {
    title: "Shell 命令",
    group: "集成",
    fields: [
      { key: "command", label: "命令", kind: "textarea" },
      { key: "cwd", label: "工作目录", kind: "text" },
    ],
  },
  git: {
    title: "Git",
    group: "集成",
    fields: [
      { key: "action", label: "操作", kind: "select", options: ["status", "pull", "log"] },
      { key: "projectId", label: "项目 ID 或路径", kind: "text" },
    ],
  },
  deploy: {
    title: "宝塔部署",
    group: "集成",
    fields: [{ key: "recipeId", label: "部署配方 ID", kind: "text" }],
  },
  notify: {
    title: "通知",
    group: "集成",
    fields: [
      { key: "title", label: "标题", kind: "text" },
      { key: "body", label: "内容", kind: "textarea" },
    ],
  },
};
