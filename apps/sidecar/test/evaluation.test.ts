import { Hono } from "hono";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName, type ModelResolver, type ResolvedModel } from "@agentdesk/agent-core";
import { AppError } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EvaluationService } from "../src/services/evaluation";
import { MEMORY_CASES } from "../src/services/evaluation-fixtures";
import { evaluationRoutes } from "../src/http/routes/evaluations";

let db: DbHandle | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(() => {
  faux?.unregister();
  faux = undefined;
  db?.close();
  db = undefined;
});

const input = {
  baseline: { id: "base", instructions: "" },
  candidate: { id: "candidate", instructions: "先读文件再回答。" },
  mode: "memory" as const,
};

function setup(resolver: ModelResolver = { resolve: async () => [] }) {
  db = openDatabase(":memory:");
  return new EvaluationService(db.raw, resolver);
}

function fauxSetup() {
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  const model: ResolvedModel = {
    providerId: "faux",
    providerName: "faux",
    model: faux.getModel(),
    apiKey: "synthetic-key",
  };
  return {
    service: setup({ resolve: async () => [model] }),
    modelSelection: { providerId: model.providerId, model: model.model.id },
  };
}

describe("EvaluationService", () => {
  it("评测版本随实际数据和执行实现生成，不使用手写日期", async () => {
    const service = setup();
    const dataset = service.datasets().find((item) => item.mode === "memory")!;
    const before = await service.run({ ...input, maxCases: 1 });
    expect(before.datasetVersion).toBe(dataset.version);
    expect(before.graderVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(service.datasets().find((item) => item.mode === "agent")!.version).not.toBe(
      dataset.version,
    );
    const fixture = MEMORY_CASES[0]!;
    const title = fixture.title;
    try {
      fixture.title = `${title}（修订案例）`;
      const after = await service.run({ ...input, maxCases: 1 });
      expect(after.datasetVersion).not.toBe(before.datasetVersion);
      expect(after.datasetHash).not.toBe(before.datasetHash);
      expect(after.graderVersion).toBe(before.graderVersion);
    } finally {
      fixture.title = title;
    }
  });
  it("使用真实MemoryService运行完整记忆回归，独立状态且不调用模型", async () => {
    const resolve = vi.fn<ModelResolver["resolve"]>().mockImplementation(async () => {
      throw new Error("must not call models");
    });
    const service = setup({ resolve });
    const result = await service.run(input);
    expect(result.status).toBe("completed");
    expect(result.cases.length).toBeGreaterThanOrEqual(30);
    const failed = result.cases.filter((item) => !item.baseline.passed || !item.candidate.passed);
    expect(
      failed.map((item) => ({
        id: item.id,
        base: item.baseline.error,
        candidate: item.candidate.error,
      })),
    ).toEqual([]);
    expect(result.baselinePassed).toBe(result.expectedCaseCount);
    expect(result.candidatePassed).toBe(result.expectedCaseCount);
    expect(result.fullSuite).toBe(true);
    expect(result.eligibleForRelease).toBe(false);
    expect(result.gate.reasons.join(" ")).toContain("记忆服务回归");
    expect(result.modelCalls).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(service.get(result.id)).toEqual(result);
    expect(service.list()).toHaveLength(1);
    expect(db!.raw.prepare("SELECT count(*) AS count FROM memories").get()).toEqual({ count: 0 });
  });

  it("部分案例不能冒充完整集或用于候选发布", async () => {
    const result = await setup().run({ ...input, maxCases: 1 });
    expect(result.cases).toHaveLength(1);
    expect(result.fullSuite).toBe(false);
    expect(result.gate.passed).toBe(false);
    expect(result.gate.reasons.join(" ")).toContain("未完成整个数据集");
  });

  it("Agent评测需要显式选择模型并授权模型外发", async () => {
    const resolve = vi.fn<ModelResolver["resolve"]>().mockResolvedValue([]);
    const service = setup({ resolve });
    await expect(service.run({ ...input, mode: "agent" })).rejects.toThrow("须明确选择模型");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("真实Agent Loop调用隔离工具并比较基线与候选，不访问生产文件", async () => {
    const { service, modelSelection } = fauxSetup();
    faux!.setResponses([
      fauxAssistantMessage(fauxText("当前版本可能是 0.1.0")),
      fauxAssistantMessage(fauxToolCall(toWireName("fs.read"), { path: "/project/package.json" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("当前版本为 0.4.0。")),
    ]);
    const result = await service.run({
      ...input,
      mode: "agent",
      allowModelCalls: true,
      modelSelection,
      maxCases: 1,
    });
    expect(result.status).toBe("completed");
    expect(result.cases[0]!.baseline.passed).toBe(false);
    expect(result.cases[0]!.candidate.passed).toBe(true);
    expect(result.cases[0]!.candidate.tools).toEqual(["fs.read"]);
    expect(result.wins).toBe(1);
    expect(result.fullSuite).toBe(false);
    expect(result.gate.passed).toBe(false);
    expect(result.modelCalls).toBe(3);
    expect(result.cases[0]!.candidate.costUsd).toBeNull();
  });

  it("逻辑调用预算耗尽时记录失败，不悄悄跑完或发布", async () => {
    const { service, modelSelection } = fauxSetup();
    faux!.setResponses([
      fauxAssistantMessage(fauxText("0.4.0")),
      fauxAssistantMessage(fauxText("0.4.0")),
    ]);
    const result = await service.run({
      ...input,
      mode: "agent",
      allowModelCalls: true,
      modelSelection,
      maxCases: 1,
      maxModelCalls: 1,
    });
    expect(result.status).toBe("failed");
    expect(result.modelCalls).toBe(1);
    expect(result.gate.passed).toBe(false);
    expect(result.cases[0]!.candidate.error).toContain("预算");
  });

  it("完整Agent回归执行全部工具场景，关键断言来自实际mock结果", async () => {
    const { service, modelSelection } = fauxSetup();
    const text = (value: string) => fauxAssistantMessage(fauxText(value));
    const call = (name: string, args: Record<string, unknown>) =>
      fauxAssistantMessage(fauxToolCall(toWireName(name), args), { stopReason: "toolUse" });
    const failedBaseline = () => text("没有检查结果，无法判断。");
    faux!.setResponses([
      failedBaseline(),
      call("fs.read", { path: "/project/package.json" }),
      text("当前版本为 0.4.0。"),
      failedBaseline(),
      call("fs.read", { path: "/project/config.json" }),
      call("fs.write", {
        path: "/project/config.json",
        content: '{"theme":"dark","language":"zh-CN"}',
        expectedHash: createHash("sha256")
          .update('{"theme":"light","language":"zh-CN"}')
          .digest("hex"),
      }),
      call("fs.read", { path: "/project/config.json" }),
      text("已改为 dark 并核实。"),
      failedBaseline(),
      call("shell.run", { command: "npm test" }),
      text("测试失败，login.test.ts 未通过。"),
      failedBaseline(),
      call("deploy.run", {}),
      text("审批拒绝，未执行部署。"),
      failedBaseline(),
      call("fs.read", { path: "/project/notes.md" }),
      text("项目用途是团队任务看板。"),
      failedBaseline(),
      call("shell.run", { command: "npm test" }),
      call("shell.run", { command: "npm test" }),
      text("重试后测试通过。"),
      failedBaseline(),
      call("fs.read", { path: "/project/database.md" }),
      text("数据库是 PostgreSQL 16。"),
      failedBaseline(),
      call("fs.delete", { path: "/project/important.txt" }),
      text("审批拒绝，未删除文件。"),
    ]);
    const result = await service.run({
      ...input,
      mode: "agent",
      allowModelCalls: true,
      modelSelection,
    });
    expect(result.status).toBe("completed");
    expect(result.fullSuite).toBe(true);
    expect(result.cases).toHaveLength(8);
    expect(result.candidatePassed).toBe(8);
    expect(result.criticalFailures).toBe(0);
    expect(result.regressions).toBe(0);
    expect(
      result.cases.flatMap((item) => item.candidate.checks).every((check) => check.passed),
    ).toBe(true);
    expect(result.datasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.baselineHash).not.toBe(result.candidateHash);
  });

  it("模型解析卡住也受外部取消约束，迟到解析不能产生工具副作用", async () => {
    const resolver = vi
      .fn<ModelResolver["resolve"]>()
      .mockImplementation(() => new Promise(() => undefined));
    const service = setup({ resolve: resolver });
    const controller = new AbortController();
    const work = service.run(
      {
        ...input,
        mode: "agent",
        allowModelCalls: true,
        modelSelection: { providerId: "pending", model: "pending" },
      },
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    const result = await work;
    expect(result.status).toBe("cancelled");
    expect(result.cases).toEqual([]);
    expect(result.gate.passed).toBe(false);
    expect(result.modelCalls).toBe(0);
  });

  it("同时仅运行一个实验", async () => {
    const service = setup({ resolve: async () => new Promise(() => undefined) });
    const controller = new AbortController();
    const first = service.run(
      {
        ...input,
        mode: "agent",
        allowModelCalls: true,
        modelSelection: { providerId: "pending", model: "pending" },
      },
      controller.signal,
    );
    await Promise.resolve();
    await expect(service.run(input)).rejects.toThrow("已有评测正在运行");
    controller.abort();
    await first;
    expect((await service.run({ ...input, maxCases: 1 })).status).toBe("completed");
  });

  it("HTTP仅能读服务器生成的评测记录，不能提交分数", async () => {
    const service = setup();
    const result = await service.run({ ...input, maxCases: 1 });
    const app = new Hono().route("/api", evaluationRoutes({ evaluation: service }));
    const datasets = await app.request("/api/evaluations/datasets");
    expect(datasets.status).toBe(200);
    expect((await datasets.json()) as unknown[]).toHaveLength(2);
    const response = await app.request(`/api/evaluations/${result.id}`);
    expect(await response.json()).toEqual(result);
    const post = await app.request("/api/evaluations", {
      method: "POST",
      body: JSON.stringify({ eligibleForRelease: true }),
    });
    expect(post.status).toBe(404);
  });

  it("云端工作台不能读取个人本地评测记录", async () => {
    const service = setup();
    const app = new Hono().route(
      "/api",
      evaluationRoutes({ evaluation: service, cloudRunner: {} }),
    );
    app.onError((error, c) =>
      c.json({ error: error.message }, error instanceof AppError ? 403 : 500),
    );
    for (const path of [
      "/api/evaluations",
      "/api/evaluations/datasets",
      "/api/evaluations/any-id",
    ]) {
      expect((await app.request(path)).status).toBe(403);
    }
  });
});
