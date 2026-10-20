import type { RecipeStep } from "@agentdesk/shared";

export interface BackendPresetOptions {
  /** 服务器上的项目目录 */
  remoteDir: string;
  branch?: string;
  buildCommand?: string;
  projectType: "node" | "java" | "go" | "python" | "php";
  projectName: string;
  healthUrl?: string;
}

/** 常见后端（如 IM 服务）的部署步骤：拉代码、构建、在宝塔项目管理中重启、健康检查。 */
export function buildBackendDeploySteps(options: BackendPresetOptions): RecipeStep[] {
  const steps: RecipeStep[] = [
    { type: "login" },
    {
      type: "terminal",
      command: `cd ${options.remoteDir} && git pull origin ${options.branch ?? "main"}`,
      timeoutMs: 120_000,
      label: "拉取最新代码",
    },
  ];
  if (options.buildCommand) {
    steps.push({
      type: "terminal",
      command: `cd ${options.remoteDir} && ${options.buildCommand}`,
      timeoutMs: 15 * 60_000,
      label: "构建",
    });
  }
  steps.push({
    type: "restartProject",
    projectType: options.projectType,
    projectName: options.projectName,
    label: `重启 ${options.projectName}`,
  });
  if (options.healthUrl) {
    steps.push({
      type: "httpCheck",
      url: options.healthUrl,
      expectStatus: 200,
      retries: 10,
      label: "健康检查",
    });
  }
  steps.push({ type: "screenshot", label: "最终截图" });
  return steps;
}

export const RECIPE_PRESETS = [
  {
    key: "im-java",
    name: "IM 服务（Java / Maven）",
    options: {
      remoteDir: "/www/wwwroot/im-server",
      branch: "main",
      buildCommand: "mvn -q clean package -DskipTests",
      projectType: "java",
      projectName: "im-server",
      healthUrl: "",
    } satisfies BackendPresetOptions,
  },
  {
    key: "im-node",
    name: "IM 服务（Node.js）",
    options: {
      remoteDir: "/www/wwwroot/im-server",
      branch: "main",
      buildCommand: "npm ci && npm run build",
      projectType: "node",
      projectName: "im-server",
      healthUrl: "",
    } satisfies BackendPresetOptions,
  },
  {
    key: "go-service",
    name: "Go 服务",
    options: {
      remoteDir: "/www/wwwroot/app",
      branch: "main",
      buildCommand: "go build -o app .",
      projectType: "go",
      projectName: "app",
      healthUrl: "",
    } satisfies BackendPresetOptions,
  },
] as const;
