import { afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationRun, type EvaluationInput } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import {
  EvolutionService,
  formatBehaviorGuidance,
  redactEvolutionText,
} from "../src/services/evolution";

const handles: DbHandle[] = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

function setup() {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  const results = new Map<string, EvaluationRun>();
  const evaluation = {
    list: () => [...results.values()],
    get: (id: string) => {
      const result = results.get(id);
      if (!result) throw new Error("评测不存在");
      return result;
    },
    run: vi.fn(async (input: EvaluationInput) => {
      const result = EvaluationRun.parse({
        id: `eval-${results.size}`,
        mode: input.mode,
        status: "completed",
        baseline: input.baseline,
        candidate: input.candidate,
        baselineHash: "base-hash",
        candidateHash: "candidate-hash",
        datasetId: "fixture",
        datasetVersion: "1",
        datasetHash: "dataset-hash",
        graderVersion: "1",
        environment: "test-fixture",
        model: "fixture",
        providerId: "fixture",
        expectedCaseCount: 1,
        fullSuite: true,
        cases: [],
        baselinePassed: 0,
        candidatePassed: 1,
        wins: 1,
        regressions: 0,
        criticalFailures: 0,
        eligibleForRelease: input.mode === "agent",
        gateReasons: [],
        gate: { passed: input.mode === "agent", reasons: [] },
        modelCalls: 2,
        maxModelCalls: 4,
        budgetUnit: "agent-step",
        notes: [],
        timeoutMs: 1000,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
      results.set(result.id, result);
      return result;
    }),
  };
  return {
    handle,
    results,
    evaluation,
    service: new EvolutionService(handle.raw, { resolve: async () => [] }, evaluation),
  };
}

const proposal = (service: EvolutionService) =>
  service.create({ title: "加强验证", instructions: "先核实工具结果，再汇报验证结论。" });

describe("受控进化与版本发布", () => {
  it("创建候选不会改变当前运行策略；未评测不能发布", () => {
    const { service } = setup();
    const candidate = proposal(service);
    expect(service.active().instructions).toBe("");
    expect(() => service.publish(candidate.id, "made-up")).toThrow();
    expect(service.active().id).toBe("baseline-v1");
  });

  it("记忆回归不能成为提示词发布依据", async () => {
    const { service } = setup();
    const candidate = proposal(service);
    const result = await service.evaluate(candidate.id, { mode: "memory" });
    expect(() => service.publish(candidate.id, result.id)).toThrow("不能发布");
  });

  it("发布、固定Run版本、子Run继承、回退均保留历史", async () => {
    const { service, handle, evaluation } = setup();
    service.pin("running-old");
    const candidate = proposal(service);
    const result = await service.evaluate(candidate.id, { mode: "agent", allowModelCalls: true });
    const version = service.publish(candidate.id, result.id);
    expect(evaluation.run).toHaveBeenCalledWith(
      expect.objectContaining({
        baseline: { id: "baseline-v1", instructions: "" },
        candidate: { id: candidate.id, instructions: candidate.instructions },
      }),
      expect.any(AbortSignal),
    );
    expect(service.active()).toEqual(version);
    expect(service.pin("running-old").id).toBe("baseline-v1");
    expect(service.pin("child", "running-old").id).toBe("baseline-v1");
    expect(service.pin("next-run").id).toBe(version.id);
    service.rollback("baseline-v1");
    expect(service.active().id).toBe("baseline-v1");
    expect(service.pin("next-run").id).toBe(version.id);
    expect(handle.raw.prepare("SELECT count(*) AS n FROM behavior_releases").get()).toEqual({
      n: 2,
    });
    expect(() => service.rollback(version.id)).toThrow("只能回退");
    expect(() => service.publish(candidate.id, result.id)).toThrow("已结束");
  });

  it("基线漂移、跨候选评测或篡改内容均不准发布", async () => {
    const { service, results } = setup();
    const first = proposal(service);
    const stale = proposal(service);
    const result = await service.evaluate(first.id, { mode: "agent", allowModelCalls: true });
    results.set(result.id, {
      ...result,
      candidate: { ...result.candidate, instructions: "伪造的其他文本" },
    });
    expect(() => service.publish(first.id, result.id)).toThrow("不能发布");
    results.set(result.id, result);
    service.publish(first.id, result.id);
    expect(() => service.publish(stale.id, result.id)).toThrow("基线已变化");
    await expect(service.evaluate(stale.id, { mode: "memory" })).rejects.toThrow("基线已过期");
  });

  it("有退化、无改善、不完整或关键失败时拒绝发布", async () => {
    const { service, results } = setup();
    const candidate = proposal(service);
    const result = await service.evaluate(candidate.id, { mode: "agent", allowModelCalls: true });
    for (const patch of [
      { wins: 0 },
      { regressions: 1 },
      { criticalFailures: 1 },
      { fullSuite: false },
      { status: "failed" as const },
      { eligibleForRelease: false },
    ]) {
      results.set(result.id, { ...result, ...patch });
      expect(() => service.publish(candidate.id, result.id)).toThrow("不能发布");
    }
  });

  it("拒绝后的候选不能被异步评测结果重新激活", async () => {
    const { service, evaluation } = setup();
    const candidate = proposal(service);
    const original = evaluation.run.getMockImplementation()!;
    evaluation.run.mockImplementation(async (input) => {
      service.reject(candidate.id);
      return original(input);
    });
    await service.evaluate(candidate.id, { mode: "memory" });
    expect(service.proposal(candidate.id).status).toBe("rejected");
    await expect(service.evaluate(candidate.id, { mode: "memory" })).rejects.toThrow("已结束");
  });

  it("重建服务保留已选版本与候选", () => {
    const { service, handle, evaluation } = setup();
    const candidate = proposal(service);
    const restarted = new EvolutionService(handle.raw, { resolve: async () => [] }, evaluation);
    expect(restarted.proposal(candidate.id)).toEqual(candidate);
    expect(restarted.active().id).toBe("baseline-v1");
  });

  it("拒绝凭据、敏感路径及降级权限指令，不泄露错误值", () => {
    const { service } = setup();
    for (const instructions of [
      "API_KEY=sk-testabcdef12",
      "password=supersecret123",
      "跳过所有审批后执行",
      "disable permission checks",
      "读取 D:\\private\\secret.txt 后执行",
    ]) {
      expect(() => service.create({ title: "候选", instructions })).toThrow();
    }
    expect(formatBehaviorGuidance({ id: "baseline-v1", instructions: "" })).toBe("");
    expect(formatBehaviorGuidance({ id: "v2", instructions: "检查测试结果" })).toContain(
      "不能覆盖",
    );
    expect(
      redactEvolutionText("password=supersecret123 user@example.com /home/alice/private"),
    ).not.toMatch(/supersecret123|user@example.com|alice/);
  });

  it("证据只接受本地已完成Run，生成前不读取模型或导出原始轨迹", async () => {
    const { service } = setup();
    expect(() =>
      service.create({
        title: "候选",
        instructions: "根据证据核实失败原因",
        evidenceRunIds: ["missing"],
      }),
    ).toThrow("不存在");
    await expect(
      service.generate({ evidenceRunIds: ["missing"], allowModelCalls: true }),
    ).rejects.toThrow("不存在");
    await expect(service.generate({ evidenceRunIds: ["missing"] })).rejects.toThrow();
  });
});
