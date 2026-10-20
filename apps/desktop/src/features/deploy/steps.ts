import type { RecipeStep } from "@agentdesk/shared";

type StepType = RecipeStep["type"];

export interface StepFieldSpec {
  key: string;
  label: string;
  kind: "text" | "number" | "select" | "textarea";
  options?: string[];
}

export const STEP_TYPES: Array<{ type: StepType; label: string }> = [
  { type: "login", label: "登录面板" },
  { type: "open", label: "打开页面" },
  { type: "terminal", label: "终端命令" },
  { type: "restartProject", label: "重启项目" },
  { type: "click", label: "点击" },
  { type: "fill", label: "填写" },
  { type: "waitFor", label: "等待元素" },
  { type: "httpCheck", label: "健康检查" },
  { type: "sleep", label: "等待" },
  { type: "screenshot", label: "截图" },
];

export const STEP_FIELDS: Record<StepType, StepFieldSpec[]> = {
  login: [],
  open: [{ key: "path", label: "路径", kind: "text" }],
  terminal: [
    { key: "command", label: "命令", kind: "textarea" },
    { key: "expect", label: "期望输出（可选）", kind: "text" },
    { key: "timeoutMs", label: "超时 ms", kind: "number" },
  ],
  restartProject: [
    {
      key: "projectType",
      label: "项目类型",
      kind: "select",
      options: ["node", "java", "go", "python", "php"],
    },
    { key: "projectName", label: "项目名", kind: "text" },
  ],
  click: [
    { key: "text", label: "按钮文字", kind: "text" },
    { key: "selector", label: "或 CSS 选择器", kind: "text" },
  ],
  fill: [
    { key: "selector", label: "CSS 选择器", kind: "text" },
    { key: "value", label: "值", kind: "text" },
  ],
  waitFor: [
    { key: "text", label: "文字", kind: "text" },
    { key: "selector", label: "或 CSS 选择器", kind: "text" },
    { key: "timeoutMs", label: "超时 ms", kind: "number" },
  ],
  httpCheck: [
    { key: "url", label: "URL", kind: "text" },
    { key: "expectStatus", label: "期望状态码", kind: "number" },
    { key: "retries", label: "重试次数", kind: "number" },
  ],
  sleep: [{ key: "ms", label: "毫秒", kind: "number" }],
  screenshot: [],
};

export function defaultStep(type: StepType): RecipeStep {
  switch (type) {
    case "login":
      return { type };
    case "open":
      return { type, path: "/" };
    case "terminal":
      return { type, command: "", timeoutMs: 120_000 };
    case "restartProject":
      return { type, projectType: "java", projectName: "" };
    case "click":
      return { type, text: "" };
    case "fill":
      return { type, selector: "", value: "" };
    case "waitFor":
      return { type, text: "", timeoutMs: 30_000 };
    case "httpCheck":
      return { type, url: "http://", expectStatus: 200, retries: 5 };
    case "sleep":
      return { type, ms: 2000 };
    case "screenshot":
      return { type };
  }
}
