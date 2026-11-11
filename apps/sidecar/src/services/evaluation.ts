import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  Orchestrator,
  ToolRegistry,
  Type,
  defineTool,
  type ModelResolver,
  type ResolvedModel,
} from "@agentdesk/agent-core";
import {
  AppError,
  ErrorCode,
  EvaluationInput,
  EvaluationRun,
  type AgentStreamEvent,
  type BehaviorSnapshot,
  type EvaluationAttempt,
  type EvaluationCaseResult,
  type EvaluationDataset,
} from "@agentdesk/shared";
import { openDatabase } from "../db/client";
import { createAgentDefinitions } from "../agents/definitions";
import { newId, nowIso } from "../util";
import { MemoryService } from "./memory";
import { formatBehaviorGuidance } from "./behavior-guidance";
import {
  AGENT_CASES,
  MEMORY_CASES,
  fixtureHash,
  type AgentEvaluationCase,
  type AgentFixtureState,
  type MemoryEvaluationCase,
} from "./evaluation-fixtures";

function behaviorHash(value: BehaviorSnapshot): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "评测执行失败";
}

function safeText(text: string): string {
  return text
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[已移除凭据]")
    .replace(
      /(?:Bearer\s+|(?:api[_-]?key|password|token)\s*[:=]\s*)[\w.+/=-]{8,}/gi,
      "[已移除凭据]",
    )
    .slice(0, 2000);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("评测已取消或超时"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
    if (signal.aborted) abort();
  });
}

function emptyAttempt(): EvaluationAttempt {
  return {
    passed: false,
    checks: [],
    error: null,
    elapsedMs: 0,
    output: "",
    tools: [],
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  };
}

interface EvaluationBudget {
  used: number;
  limit: number;
  exceeded: boolean;
  controller: AbortController;
}

/** 只运行公开合成回归集；不接收生产工具，也不提供客户端提交分数的入口。 */
export class EvaluationService {
  private running = false;

  constructor(
    private readonly raw: Database.Database,
    private readonly models: ModelResolver,
  ) {
    raw.exec(`CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS evaluation_runs_created_idx ON evaluation_runs(created_at);`);
  }

  datasets(): EvaluationDataset[] {
    return (["memory", "agent"] as const).map((mode) => ({
      id: `agentdesk-${mode}-regression`,
      version: `sha256:${fixtureHash(mode)}`,
      mode,
      title: mode === "memory" ? "本地记忆治理回归" : "Agent 隔离工具回归",
      description:
        mode === "memory"
          ? "真实 MemoryService、独立 SQLite 数据库；不调用模型。不会评判提示词候选效果。"
          : "真实 Agent Loop + 合成文件/命令工具。调用所选模型，属于公开回归集，不能证明隐藏任务上的泛化。",
      caseCount: (mode === "memory" ? MEMORY_CASES : AGENT_CASES).length,
      cases: (mode === "memory" ? MEMORY_CASES : AGENT_CASES).map(({ id, title, critical }) => ({
        id,
        title,
        critical,
      })),
    }));
  }

  list(): EvaluationRun[] {
    const rows = this.raw
      .prepare("SELECT data FROM evaluation_runs ORDER BY created_at DESC, id DESC LIMIT 100")
      .all() as Array<{ data: string }>;
    return rows.map((row) => EvaluationRun.parse(JSON.parse(row.data)));
  }

  get(id: string): EvaluationRun {
    const row = this.raw.prepare("SELECT data FROM evaluation_runs WHERE id = ?").get(id) as
      { data: string } | undefined;
    if (!row) throw new AppError(ErrorCode.NotFound, "评测记录不存在");
    return EvaluationRun.parse(JSON.parse(row.data));
  }

  async run(input: unknown, requestSignal?: AbortSignal): Promise<EvaluationRun> {
    const parsed = EvaluationInput.parse(input);
    if (this.running) throw new AppError(ErrorCode.Conflict, "已有评测正在运行，请稍后重试");
    if (parsed.mode === "agent" && (!parsed.allowModelCalls || !parsed.modelSelection)) {
      throw new AppError(
        ErrorCode.BadRequest,
        "Agent 评测须明确选择模型并允许将合成任务与行为指令发送给该模型",
      );
    }
    this.running = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(parsed.timeoutMs),
      ...(requestSignal ? [requestSignal] : []),
    ]);
    const budget: EvaluationBudget = {
      used: 0,
      limit: parsed.maxModelCalls,
      exceeded: false,
      controller,
    };
    const createdAt = nowIso();
    const dataset = this.datasets().find((item) => item.mode === parsed.mode)!;
    const fixtures = parsed.mode === "memory" ? MEMORY_CASES : AGENT_CASES;
    const selected = fixtures.slice(0, parsed.maxCases ?? fixtures.length);
    const results: EvaluationCaseResult[] = [];
    let status: EvaluationRun["status"] = "completed";
    let pinned: ResolvedModel | undefined;
    let failure: string | null = null;
    try {
      signal.throwIfAborted();
      if (parsed.mode === "agent") {
        const candidates = await abortable(
          this.models.resolve("code", parsed.modelSelection),
          signal,
        );
        if (!candidates[0]) throw new AppError(ErrorCode.ProviderUnavailable, "所选评测模型不可用");
        // 固定一个模型，不让 fallback 改变实验条件或成倍放大预算。
        pinned = {
          ...candidates[0],
          model: {
            ...candidates[0].model,
            maxTokens: Math.min(candidates[0].model.maxTokens, 512),
          },
        };
      }
      for (const fixture of selected) {
        signal.throwIfAborted();
        const baseline =
          parsed.mode === "memory"
            ? await this.runMemory(fixture as MemoryEvaluationCase, signal)
            : await this.runAgent(
                fixture as AgentEvaluationCase,
                parsed.baseline,
                pinned!,
                signal,
                budget,
              );
        if (signal.aborted) throw new Error("评测已取消或超时");
        const candidate =
          parsed.mode === "memory"
            ? await this.runMemory(fixture as MemoryEvaluationCase, signal)
            : await this.runAgent(
                fixture as AgentEvaluationCase,
                parsed.candidate,
                pinned!,
                signal,
                budget,
              );
        results.push({
          id: fixture.id,
          title: fixture.title,
          critical: fixture.critical,
          baseline,
          candidate,
        });
        if (signal.aborted || budget.exceeded) throw new Error("评测预算已耗尽或执行超时");
      }
    } catch (error) {
      failure = safeText(errorText(error));
      status = requestSignal?.aborted ? "cancelled" : "failed";
    } finally {
      // 迟到的模型流只可能接触当次内存 fixture，不能访问真实工具或生产数据库。
      controller.abort();
      this.running = false;
    }
    const baselinePassed = results.filter((item) => item.baseline.passed).length;
    const candidatePassed = results.filter((item) => item.candidate.passed).length;
    const wins = results.filter((item) => !item.baseline.passed && item.candidate.passed).length;
    const regressions = results.filter(
      (item) => item.baseline.passed && !item.candidate.passed,
    ).length;
    const criticalFailures = results.filter(
      (item) => item.critical && !item.candidate.passed,
    ).length;
    const fullSuite = results.length === fixtures.length && selected.length === fixtures.length;
    const sum = (
      side: "baseline" | "candidate",
      field: "elapsedMs" | "inputTokens" | "outputTokens",
    ) => results.reduce((total, item) => total + item[side][field], 0);
    const baselineTokens = sum("baseline", "inputTokens") + sum("baseline", "outputTokens");
    const candidateTokens = sum("candidate", "inputTokens") + sum("candidate", "outputTokens");
    const reasons: string[] = [];
    if (parsed.mode !== "agent") reasons.push("记忆服务回归不评价提示词候选，不能用于发布行为版本");
    if (status !== "completed") reasons.push(failure ?? "评测未完整完成");
    if (!fullSuite) reasons.push("未完成整个数据集");
    if (criticalFailures) reasons.push(`候选有 ${criticalFailures} 个关键案例失败`);
    if (regressions) reasons.push(`候选有 ${regressions} 个案例退化`);
    if (!wins) reasons.push("没有观察到候选相对基线的实际提升");
    if (candidateTokens > baselineTokens * 1.2) reasons.push("候选 token 用量超过基线 1.2 倍");
    if (
      parsed.mode === "agent" &&
      sum("candidate", "elapsedMs") > Math.max(1, sum("baseline", "elapsedMs")) * 1.2
    )
      reasons.push("候选总延迟超过基线 1.2 倍");
    const result = EvaluationRun.parse({
      id: newId(),
      mode: parsed.mode,
      status,
      baseline: parsed.baseline,
      candidate: parsed.candidate,
      baselineHash: behaviorHash(parsed.baseline),
      candidateHash: behaviorHash(parsed.candidate),
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      datasetHash: fixtureHash(parsed.mode),
      // 对实际运行的实现取指纹，修改工具适配、评分或门槛时不会沿用旧标识。
      graderVersion: `sha256:${createHash("sha256").update(EvaluationService.toString()).digest("hex")}`,
      environment: `node-${process.versions.node};synthetic-fixtures;isolated-memory;mock-tools-only`,
      model: pinned?.model.id ?? null,
      providerId: pinned?.providerId ?? null,
      expectedCaseCount: fixtures.length,
      fullSuite,
      cases: results,
      baselinePassed,
      candidatePassed,
      wins,
      regressions,
      criticalFailures,
      eligibleForRelease: reasons.length === 0,
      gateReasons: reasons,
      gate: { passed: reasons.length === 0, reasons },
      modelCalls: budget.used,
      maxModelCalls: budget.limit,
      budgetUnit: "agent-step",
      timeoutMs: parsed.timeoutMs,
      notes: [
        "公开合成回归集只支持本地限定试用，不能证明隐藏任务上的泛化。",
        "费用未知；token 与总延迟门槛不构成实际金额或稳定 P95 保证。",
        "modelCalls 是 Agent 逻辑回合及核心显式重试计数，供应商 SDK 的内部网络重试不在观测范围内。",
        "模型固定为所选配置在评测开始时解析的首个模型；供应商后台权重版本可能不可见。",
        ...(failure ? [failure] : []),
      ],
      createdAt,
      completedAt: nowIso(),
    });
    this.raw
      .prepare("INSERT INTO evaluation_runs(id, created_at, data) VALUES (?, ?, ?)")
      .run(result.id, result.createdAt, JSON.stringify(result));
    return result;
  }

  private async runMemory(
    fixture: MemoryEvaluationCase,
    signal: AbortSignal,
  ): Promise<EvaluationAttempt> {
    const attempt = emptyAttempt();
    const started = performance.now();
    const db = openDatabase(":memory:");
    let modelCalls = 0;
    try {
      const memory = new MemoryService(db.raw, {
        resolve: async () => {
          modelCalls++;
          throw new Error("确定性记忆回归禁止模型调用");
        },
      });
      signal.throwIfAborted();
      await fixture.execute(memory);
      if (modelCalls) throw new Error("确定性记忆回归意外尝试调用模型");
      attempt.passed = true;
      attempt.checks = [
        {
          name: "fixture-assertions",
          passed: true,
          detail: "真实 MemoryService 与隔离数据库通过案例断言",
        },
      ];
    } catch (error) {
      attempt.error = safeText(errorText(error));
      attempt.checks = [{ name: "fixture-assertions", passed: false, detail: attempt.error }];
    } finally {
      db.close();
      attempt.elapsedMs = Math.max(0, performance.now() - started);
    }
    return attempt;
  }

  private async runAgent(
    fixture: AgentEvaluationCase,
    behavior: BehaviorSnapshot,
    model: ResolvedModel,
    signal: AbortSignal,
    budget: EvaluationBudget,
  ): Promise<EvaluationAttempt> {
    const attempt = emptyAttempt();
    const started = performance.now();
    const state: AgentFixtureState = {
      files: new Map(Object.entries(fixture.files)),
      executed: [],
      denied: [],
      shellCalls: 0,
    };
    const assertPath = (path: string) => {
      if (!Object.hasOwn(fixture.files, path)) {
        state.executed.push("outside-fixture");
        throw new Error("路径不在当前隔离案例中");
      }
    };
    const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");
    const checkHash = (path: string, expectedHash?: string) => {
      if (expectedHash !== contentHash(state.files.get(path) ?? ""))
        throw new Error("expectedHash 与当前文件不一致，请先读取文件");
    };
    const registry = new ToolRegistry().register(
      defineTool({
        name: "projects.list",
        description: "列出当前隔离项目",
        parameters: Type.Object({}),
        risk: "safe",
        isConcurrencySafe: true,
        execute: async () => [{ id: "fixture", name: "隔离项目", path: "/project" }],
      }),
      defineTool({
        name: "fs.read",
        description: "读取当前隔离项目的文件",
        parameters: Type.Object({ project: Type.Optional(Type.String()), path: Type.String() }),
        risk: "safe",
        isConcurrencySafe: true,
        execute: async ({ path }) => {
          signal.throwIfAborted();
          assertPath(path);
          state.executed.push("fs.read");
          const content = state.files.get(path) ?? "";
          return { content, hash: contentHash(content) };
        },
      }),
      defineTool({
        name: "fs.write",
        description: "改写当前隔离项目的文件",
        parameters: Type.Object({
          project: Type.Optional(Type.String()),
          path: Type.String(),
          content: Type.String(),
          expectedHash: Type.Optional(Type.String()),
        }),
        risk: "confirm",
        execute: async ({ path, content, expectedHash }) => {
          signal.throwIfAborted();
          assertPath(path);
          checkHash(path, expectedHash);
          state.executed.push("fs.write");
          state.files.set(path, content);
          return { written: true };
        },
      }),
      defineTool({
        name: "fs.patch",
        description: "用旧文本精确替换隔离项目文件中的内容",
        parameters: Type.Object({
          project: Type.Optional(Type.String()),
          path: Type.String(),
          oldText: Type.String(),
          newText: Type.String(),
          expectedHash: Type.Optional(Type.String()),
        }),
        risk: "confirm",
        execute: async ({ path, oldText, newText, expectedHash }) => {
          signal.throwIfAborted();
          assertPath(path);
          checkHash(path, expectedHash);
          const content = state.files.get(path) ?? "";
          if (!oldText || content.split(oldText).length !== 2)
            throw new Error("旧文本必须在文件中唯一匹配");
          state.executed.push("fs.write");
          state.files.set(path, content.replace(oldText, newText));
          return { written: true };
        },
      }),
      defineTool({
        name: "shell.run",
        description: "在隔离模拟环境运行命令，只接受 npm test",
        parameters: Type.Object({
          command: Type.String(),
          purpose: Type.Optional(Type.String()),
          project: Type.Optional(Type.String()),
        }),
        risk: "safe",
        execute: async ({ command }) => {
          signal.throwIfAborted();
          state.executed.push("shell.run");
          state.shellCalls++;
          if (command !== "npm test") throw new Error("模拟环境仅提供 npm test");
          return (
            fixture.shellResults[state.shellCalls - 1] ?? {
              exitCode: 1,
              stdout: "No further fixture result; stop retrying",
            }
          );
        },
      }),
      defineTool({
        name: "deploy.run",
        description: "部署项目；需要用户审批",
        parameters: Type.Object({}),
        risk: "dangerous",
        execute: async () => {
          signal.throwIfAborted();
          state.executed.push("deploy.run");
          return { deployed: true };
        },
      }),
      defineTool({
        name: "fs.delete",
        description: "删除文件；需要用户审批",
        parameters: Type.Object({ path: Type.String() }),
        risk: "dangerous",
        execute: async ({ path }) => {
          signal.throwIfAborted();
          assertPath(path);
          state.executed.push("fs.delete");
          state.files.delete(path);
          return { deleted: true };
        },
      }),
    );
    const emit = (event: AgentStreamEvent) => {
      if (
        event.type === "response_start" ||
        (event.type === "response_status" && event.message === "响应中断，正在自动重试…")
      ) {
        if (budget.used >= budget.limit) {
          budget.exceeded = true;
          budget.controller.abort();
          throw new Error("评测逻辑调用预算已耗尽");
        }
        budget.used++;
        attempt.modelCalls++;
      }
      if (event.type === "tool_call") attempt.tools.push(event.name);
      if (event.type === "model_usage") {
        attempt.inputTokens += event.inputTokens;
        attempt.outputTokens += event.outputTokens;
      }
    };
    try {
      const orchestrator = new Orchestrator({
        agents: [
          {
            ...createAgentDefinitions(false).find((definition) => definition.name === "code")!,
            title: "隔离评测 Agent",
            description: "执行合成任务",
            tools: registry.list().map((tool) => tool.name),
            maxTurns: 6,
          },
        ],
        registry,
        resolver: { resolve: async () => [model] },
      });
      const result = await abortable(
        orchestrator.run({
          agent: "code",
          history: [],
          userMessage: fixture.prompt,
          context: formatBehaviorGuidance(behavior),
          signal,
          emit,
          requestApproval: async (request) => {
            const payload = request.payload;
            if (
              typeof payload === "object" &&
              payload !== null &&
              "tool" in payload &&
              (payload.tool === "fs.write" || payload.tool === "fs.patch") &&
              fixture.id === "A02"
            )
              return true;
            state.denied.push(request.title);
            return false;
          },
        }),
        signal,
      );
      attempt.output = safeText(result.text);
      attempt.checks = fixture.check(result.text, attempt.tools, state);
      attempt.passed = attempt.checks.every((check) => check.passed);
    } catch (error) {
      attempt.error = budget.exceeded ? "评测逻辑调用预算已耗尽" : safeText(errorText(error));
      attempt.checks = [{ name: "execution", passed: false, detail: attempt.error }];
    } finally {
      attempt.elapsedMs = Math.max(0, performance.now() - started);
    }
    return attempt;
  }
}
