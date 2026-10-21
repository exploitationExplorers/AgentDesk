import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { completeStructured, type ModelResolver } from "@agentdesk/agent-core";
import {
  BrowserSessionManager,
  RECIPE_PRESETS,
  buildBackendDeploySteps,
  runDeployRecipe,
  type BackendPresetOptions,
} from "@agentdesk/integrations";
import {
  AppError,
  DeployRecipeInput,
  ErrorCode,
  ServerInput,
  describeStep,
  type DeployRecipe,
  type DeployRun,
  type Server,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { GLOBAL_CHANNEL, type EventHub, type GlobalEvent } from "../events";
import type { SecretStore } from "../secrets";
import { newId, nowIso } from "../util";
import type { ApprovalService } from "./approvals";
import type { SettingsService } from "./settings";

type StoredServer = Omit<Server, "hasPassword">;

const passwordId = (serverId: string) => `server:${serverId}`;
export const deployChannel = (runId: string) => `deploy:${runId}`;

const VisionPoint = z.object({
  found: z.boolean(),
  x: z.number().optional(),
  y: z.number().optional(),
});

export class DeployService {
  private readonly servers: Collection<StoredServer>;
  private readonly recipes: Collection<DeployRecipe>;
  private readonly runs: Collection<DeployRun>;
  private readonly controllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<DeployRun>>();
  readonly browser: BrowserSessionManager;

  constructor(
    db: Db,
    private readonly secrets: SecretStore,
    private readonly approvals: ApprovalService,
    private readonly hub: EventHub,
    private readonly models: ModelResolver,
    settings: SettingsService,
    private readonly dataDir: string,
    /** 与 BrowserService 共用，避免两套 Playwright profile */
    browserManager?: BrowserSessionManager,
  ) {
    this.servers = new Collection<StoredServer>(db, "servers");
    this.recipes = new Collection<DeployRecipe>(db, "recipes");
    this.runs = new Collection<DeployRun>(db, "deployRuns");
    this.browser =
      browserManager ??
      new BrowserSessionManager(
        join(dataDir, "browser-profiles"),
        () => settings.get().browserChannel,
      );
    for (const run of this.runs.list()) {
      if (
        run.status === "running" ||
        run.status === "awaiting_approval" ||
        run.status === "needs_manual"
      ) {
        this.runs.put({
          ...run,
          status: "failed",
          error: "sidecar 重启，任务中断",
          updatedAt: nowIso(),
        });
      }
    }
  }

  // ---------- 服务器 ----------

  listServers(): Server[] {
    return this.servers
      .list()
      .map((s) => ({ ...s, hasPassword: this.secrets.has(passwordId(s.id)) }));
  }

  getServer(id: string): Server {
    const s = this.servers.get(id);
    if (!s) throw new AppError(ErrorCode.NotFound, "服务器不存在");
    return { ...s, hasPassword: this.secrets.has(passwordId(id)) };
  }

  saveServer(input: unknown, id?: string): Server {
    const data = ServerInput.parse(input);
    const { password, ...rest } = data;
    const existing = id ? this.servers.get(id) : undefined;
    if (id && !existing) throw new AppError(ErrorCode.NotFound, "服务器不存在");
    const stored: StoredServer = {
      id: id ?? newId(),
      ...rest,
      createdAt: existing?.createdAt ?? nowIso(),
    };
    this.servers.put(stored);
    if (password) this.secrets.set(passwordId(stored.id), password);
    return this.getServer(stored.id);
  }

  async deleteServer(id: string): Promise<void> {
    if (this.recipes.list().some((r) => r.serverId === id)) {
      throw new AppError(ErrorCode.Conflict, "仍有部署配方使用该服务器，请先删除配方");
    }
    await this.browser.close(id);
    this.servers.delete(id);
    this.secrets.delete(passwordId(id));
  }

  /** 打开有头浏览器到面板，便于首次登录或手动检查。 */
  async openPanel(id: string): Promise<void> {
    const server = this.getServer(id);
    const page = await this.browser.page(id, { headless: false });
    await page.goto(server.panelUrl, { waitUntil: "domcontentloaded" });
  }

  // ---------- 配方 ----------

  listRecipes(): DeployRecipe[] {
    return this.recipes.list();
  }

  getRecipe(id: string): DeployRecipe {
    const r = this.recipes.get(id);
    if (!r) throw new AppError(ErrorCode.NotFound, "部署配方不存在");
    return r;
  }

  saveRecipe(input: unknown, id?: string): DeployRecipe {
    const data = DeployRecipeInput.parse(input);
    this.getServer(data.serverId);
    if (id) this.getRecipe(id);
    return this.recipes.put({ id: id ?? newId(), ...data, updatedAt: nowIso() });
  }

  deleteRecipe(id: string): void {
    this.recipes.delete(id);
  }

  presets() {
    return RECIPE_PRESETS.map((p) => ({
      key: p.key,
      name: p.name,
      options: p.options,
      steps: buildBackendDeploySteps(p.options),
    }));
  }

  buildPresetSteps(options: BackendPresetOptions) {
    return buildBackendDeploySteps(options);
  }

  // ---------- 执行 ----------

  listRuns(recipeId?: string): DeployRun[] {
    const all = this.runs.list();
    return (recipeId ? all.filter((r) => r.recipeId === recipeId) : all).slice(0, 50);
  }

  getRun(id: string): DeployRun {
    const r = this.runs.get(id);
    if (!r) throw new AppError(ErrorCode.NotFound, "部署记录不存在");
    return r;
  }

  private save(run: DeployRun): DeployRun {
    const next = this.runs.put({ ...run, updatedAt: nowIso() });
    this.hub.publish(deployChannel(run.id), { type: "run", run: next });
    this.hub.publish(GLOBAL_CHANNEL, {
      type: "deploy_updated",
      runId: run.id,
      status: run.status,
    } satisfies GlobalEvent);
    return next;
  }

  /**
   * 创建部署任务。默认先生成审批草稿；
   * skipApproval 仅用于调用方已经完成审批的场景（Agent 工具审批、工作流审批节点）。
   */
  start(recipeId: string, options: { skipApproval?: boolean } = {}): DeployRun {
    const recipe = this.getRecipe(recipeId);
    const server = this.getServer(recipe.serverId);
    const run = this.save({
      id: newId(),
      recipeId,
      recipeName: recipe.name,
      status: options.skipApproval ? "running" : "awaiting_approval",
      steps: recipe.steps.map((step, index) => ({
        index,
        title: describeStep(step),
        status: "pending",
        log: [],
        screenshot: null,
        startedAt: null,
        endedAt: null,
      })),
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    this.hub.retain(deployChannel(run.id));

    const completion = (async () => {
      if (!options.skipApproval) {
        const approved = await this.approvals.request({
          kind: "deploy",
          title: `部署「${recipe.name}」到 ${server.name}`,
          detail: recipe.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`).join("\n"),
          risk: "dangerous",
          payload: { recipeId, runId: run.id },
        });
        if (!approved)
          return this.save({ ...this.getRun(run.id), status: "cancelled", error: "用户拒绝部署" });
        this.save({ ...this.getRun(run.id), status: "running" });
      }
      return this.execute(run.id, 0);
    })();
    this.track(run.id, completion);
    return run;
  }

  /** 从失败步骤断点续跑 */
  retry(runId: string): DeployRun {
    const run = this.getRun(runId);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new AppError(ErrorCode.Conflict, "只有失败或取消的任务可以重试");
    }
    const from = Math.max(
      0,
      run.steps.findIndex((s) => s.status !== "succeeded"),
    );
    const reset = this.save({
      ...run,
      status: "running",
      error: null,
      steps: run.steps.map((s) =>
        s.index >= from
          ? { ...s, status: "pending", log: [], screenshot: null, startedAt: null, endedAt: null }
          : s,
      ),
    });
    this.hub.retain(deployChannel(runId));
    this.track(runId, this.execute(runId, from));
    return reset;
  }

  cancel(runId: string): DeployRun {
    this.controllers.get(runId)?.abort();
    const run = this.getRun(runId);
    if (run.status === "awaiting_approval") {
      const pending = this.approvals
        .list("pending")
        .find((a) => (a.payload as { runId?: string })?.runId === runId);
      if (pending) this.approvals.resolve(pending.id, false);
    }
    return run;
  }

  /** 等待任务结束（供 Agent 工具和工作流节点使用） */
  wait(runId: string): Promise<DeployRun> {
    return this.completions.get(runId) ?? Promise.resolve(this.getRun(runId));
  }

  screenshotPath(runId: string, index: number): string {
    const file = join(
      this.dataDir,
      "screenshots",
      runId,
      `step-${String(index).padStart(2, "0")}.png`,
    );
    if (!existsSync(file)) throw new AppError(ErrorCode.NotFound, "截图不存在");
    return file;
  }

  private track(runId: string, completion: Promise<DeployRun>) {
    const guarded = completion.catch((error) =>
      this.save({
        ...this.getRun(runId),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    this.completions.set(runId, guarded);
    void guarded.finally(() => this.completions.delete(runId));
  }

  private async execute(runId: string, startAt: number): Promise<DeployRun> {
    const run = this.getRun(runId);
    const recipe = this.getRecipe(run.recipeId);
    const server = this.getServer(recipe.serverId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);

    const mutate = (fn: (r: DeployRun) => DeployRun) => this.save(fn(this.getRun(runId)));
    const patchStep = (index: number, patch: Partial<DeployRun["steps"][number]>) =>
      mutate((r) => ({
        ...r,
        steps: r.steps.map((s) => (s.index === index ? { ...s, ...patch } : s)),
      }));

    try {
      const result = await runDeployRecipe({
        recipe,
        server,
        password: this.secrets.get(passwordId(server.id)) ?? "",
        browser: this.browser,
        screenshotDir: join(this.dataDir, "screenshots", runId),
        startAt,
        signal: controller.signal,
        callbacks: {
          onStepStart: (index) => patchStep(index, { status: "running", startedAt: nowIso() }),
          onLog: (index, message) => {
            if (index < 0) return;
            mutate((r) => ({
              ...r,
              steps: r.steps.map((s) =>
                s.index === index ? { ...s, log: [...s.log, message].slice(-200) } : s,
              ),
            }));
          },
          onStepEnd: (index, status, screenshot) =>
            patchStep(index, {
              status,
              endedAt: nowIso(),
              screenshot: screenshot ? basename(screenshot) : null,
            }),
          onNeedsManual: (reason) => {
            mutate((r) => ({ ...r, status: "needs_manual", error: reason }));
            this.hub.publish(GLOBAL_CHANNEL, {
              type: "notification",
              title: "部署需要你处理",
              body: reason,
            } satisfies GlobalEvent);
          },
          locateByVision: (shot, target) => this.locateByVision(shot, target),
        },
      });
      return mutate((r) => ({
        ...r,
        status: result.status,
        error: result.error,
      }));
    } finally {
      this.controllers.delete(runId);
      const final = this.getRun(runId);
      this.hub.publish(GLOBAL_CHANNEL, {
        type: "notification",
        title: final.status === "succeeded" ? "部署成功" : "部署未完成",
        body: `${final.recipeName}：${final.status === "succeeded" ? "全部步骤已完成" : (final.error ?? final.status)}`,
      } satisfies GlobalEvent);
    }
  }

  /** 选择器失效时，用多模态模型在截图中定位目标并返回坐标 */
  private async locateByVision(
    screenshot: Buffer,
    target: string,
  ): Promise<{ x: number; y: number } | null> {
    const models = await this.models.resolve("deploy");
    if (models.length === 0) return null;
    try {
      const point = await completeStructured({
        models,
        schema: VisionPoint,
        systemPrompt: "你是 UI 定位助手。截图尺寸 1440x900，返回目标元素中心点的像素坐标。",
        prompt: [
          {
            type: "text",
            text: `找到：${target}。输出 {"found":true,"x":数字,"y":数字}，找不到输出 {"found":false}`,
          },
          { type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
        ],
      });
      return point.found && point.x !== undefined && point.y !== undefined
        ? { x: point.x, y: point.y }
        : null;
    } catch {
      return null;
    }
  }
}
