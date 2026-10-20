import { z } from "zod";

export const Server = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** 宝塔面板完整地址，包含安全入口，例如 https://1.2.3.4:8888/abcd1234 */
  panelUrl: z.string().url(),
  username: z.string(),
  hasPassword: z.boolean(),
  notes: z.string().default(""),
  createdAt: z.string(),
});
export type Server = z.infer<typeof Server>;

export const ServerInput = Server.pick({
  name: true,
  panelUrl: true,
  username: true,
  notes: true,
}).extend({
  password: z.string().optional(),
});
export type ServerInput = z.infer<typeof ServerInput>;

export const RecipeStep = z.discriminatedUnion("type", [
  z.object({ type: z.literal("login") }),
  z.object({ type: z.literal("open"), path: z.string(), label: z.string().optional() }),
  z.object({
    type: z.literal("click"),
    selector: z.string().optional(),
    text: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("fill"),
    selector: z.string(),
    value: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("terminal"),
    command: z.string(),
    /** 命令输出中出现该文本即视为完成 */
    expect: z.string().optional(),
    timeoutMs: z.number().int().positive().default(120_000),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("restartProject"),
    projectType: z.enum(["node", "java", "go", "python", "php"]),
    projectName: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("waitFor"),
    selector: z.string().optional(),
    text: z.string().optional(),
    timeoutMs: z.number().int().positive().default(30_000),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("httpCheck"),
    url: z.string().url(),
    expectStatus: z.number().int().default(200),
    retries: z.number().int().min(0).default(5),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("sleep"),
    ms: z.number().int().positive(),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal("screenshot"), label: z.string().optional() }),
]);
export type RecipeStep = z.infer<typeof RecipeStep>;

export const DeployRecipe = z.object({
  id: z.string(),
  name: z.string().min(1),
  serverId: z.string(),
  projectId: z.string().nullable(),
  description: z.string().default(""),
  steps: z.array(RecipeStep).min(1),
  updatedAt: z.string(),
});
export type DeployRecipe = z.infer<typeof DeployRecipe>;

export const DeployRecipeInput = DeployRecipe.omit({ id: true, updatedAt: true });
export type DeployRecipeInput = z.infer<typeof DeployRecipeInput>;

export const StepStatus = z.enum(["pending", "running", "succeeded", "failed", "skipped"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const RunStepState = z.object({
  index: z.number().int(),
  title: z.string(),
  status: StepStatus,
  log: z.array(z.string()),
  screenshot: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type RunStepState = z.infer<typeof RunStepState>;

export const DeployRunStatus = z.enum([
  "awaiting_approval",
  "running",
  "needs_manual",
  "succeeded",
  "failed",
  "cancelled",
]);
export type DeployRunStatus = z.infer<typeof DeployRunStatus>;

export const DeployRun = z.object({
  id: z.string(),
  recipeId: z.string(),
  recipeName: z.string(),
  status: DeployRunStatus,
  steps: z.array(RunStepState),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeployRun = z.infer<typeof DeployRun>;

export function describeStep(step: RecipeStep): string {
  if ("label" in step && step.label) return step.label;
  switch (step.type) {
    case "login":
      return "登录宝塔面板";
    case "open":
      return `打开 ${step.path}`;
    case "click":
      return `点击 ${step.text ?? step.selector ?? ""}`;
    case "fill":
      return `填写 ${step.selector}`;
    case "terminal":
      return `终端执行 ${step.command}`;
    case "restartProject":
      return `重启 ${step.projectType} 项目 ${step.projectName}`;
    case "waitFor":
      return `等待 ${step.text ?? step.selector ?? ""}`;
    case "httpCheck":
      return `健康检查 ${step.url}`;
    case "sleep":
      return `等待 ${step.ms}ms`;
    case "screenshot":
      return "截图";
  }
}
