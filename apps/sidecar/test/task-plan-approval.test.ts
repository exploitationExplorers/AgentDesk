import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

let container: Container;
let app: Hono;
let faux: FauxProviderRegistration;
const TOKEN = "test-token";

const call = (path: string, init: RequestInit = {}) =>
  app.request(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-AgentDesk-Token": TOKEN,
      ...(init.headers ?? {}),
    },
  });

const json = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
  const res = await call(path, init);
  return (await res.json()) as T;
};

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-task-plan-approval-"));
  const config = { ...loadConfig({ AGENTDESK_DATA_DIR: dataDir }), token: TOKEN };
  container = await createContainer(config, { inMemory: true });
  app = createApp(container);
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "x" },
  ];
});

afterAll(async () => {
  faux.unregister();
  await container.dispose();
});

async function createPlanGatedTask(goal: string) {
  const task = await json<{ id: string }>("/tasks", {
    method: "POST",
    body: JSON.stringify({ goal, requiresPlanApproval: true }),
  });
  return task;
}

describe("方案关口：tasks.submit_plan 工具 + 受限工具集", () => {
  it("模型配合调用 tasks.submit_plan 后，落一条 plan 产物与一条 pending 的 plan 审批", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.submit_plan"), {
          summary: "先排查登录报错日志，再定位并修复",
          steps: ["复现问题", "定位根因", "修复并验证"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("方案已提交，等待批准")),
    ]);

    const task = await createPlanGatedTask("修复登录页报错（方案关口 A）");
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_plan_approval");

    const plans = container.tasks.listArtifacts(task.id, "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.content).toContain("复现问题");

    const planApproval = container.approvals.list("pending").find((a) => a.kind === "plan");
    expect(planApproval).toBeDefined();
    expect((planApproval!.payload as { taskId?: string }).taskId).toBe(task.id);
  });

  it("approve 这条 plan 审批后，Task 迁移到 running", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.submit_plan"), {
          summary: "先调研再实施",
          steps: ["调研现状", "实施改动"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("方案已提交")),
    ]);

    const task = await createPlanGatedTask("接入新功能（方案关口 B，approve 路径）");
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_plan_approval");

    const planApproval = container.approvals
      .list("pending")
      .find((a) => a.kind === "plan" && (a.payload as { taskId?: string }).taskId === task.id)!;
    expect(planApproval).toBeDefined();

    const res = await call(`/approvals/${planApproval.id}`, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);

    await waitFor(() => container.tasks.get(task.id)?.status === "running");
    expect(container.tasks.get(task.id)!.status).toBe("running");
    // 本阶段选择不自动创建并 enqueue 新的根 Run：批准只代表"可以开始执行"，
    // 没有后续 Run 时任务停在 running，不会被自动推进到其它状态。
    expect(container.tasks.listRuns(task.id)).toHaveLength(1);
  });

  it("reject 这条 plan 审批后，Task 迁移到 planning", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.submit_plan"), {
          summary: "方案草稿",
          steps: ["步骤一"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("方案已提交")),
    ]);

    const task = await createPlanGatedTask("重构模块（方案关口 C，reject 路径）");
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_plan_approval");

    const planApproval = container.approvals
      .list("pending")
      .find((a) => a.kind === "plan" && (a.payload as { taskId?: string }).taskId === task.id)!;
    expect(planApproval).toBeDefined();

    await call(`/approvals/${planApproval.id}`, {
      method: "POST",
      body: JSON.stringify({ approved: false }),
    });

    await waitFor(() => container.tasks.get(task.id)?.status === "planning");
    expect(container.tasks.get(task.id)!.status).toBe("planning");
  });

  it("硬校验：awaiting_plan_approval 时非 followup 的根 Run 创建请求被服务层拒绝（409），不会真正执行", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.submit_plan"), {
          summary: "方案草稿",
          steps: ["步骤一", "步骤二"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("方案已提交")),
    ]);

    const task = await createPlanGatedTask("硬校验任务（方案关口 D）");
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_plan_approval");
    expect(container.tasks.listRuns(task.id)).toHaveLength(1);

    const res = await call(`/tasks/${task.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger: "resume", message: "尝试绕过方案关口直接执行" }),
    });
    expect(res.status).toBe(409);

    // 没有新 Run 被创建，任务状态也原地不动——没有一条代码路径能让它越过关口。
    expect(container.tasks.listRuns(task.id)).toHaveLength(1);
    expect(container.tasks.get(task.id)!.status).toBe("awaiting_plan_approval");
  });

  it("模型不配合（未调用 tasks.submit_plan）时降级为直接执行，Task 按现有逻辑走到 awaiting_review", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("我直接把事情做完了，不需要方案"))]);

    const task = await createPlanGatedTask("不配合方案关口的任务");
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");

    expect(container.tasks.listArtifacts(task.id, "plan")).toHaveLength(0);
    const [run] = container.tasks.listRuns(task.id);
    expect(run!.status).toBe("succeeded");
  });
});

describe("验收关口：kind='review' 审批驱动 Task 完成", () => {
  it("方案批准、followup 执行成功后落一条 review 审批；approve 后 Task 到 completed", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.submit_plan"), {
          summary: "验收关口联调方案",
          steps: ["实施", "自测"],
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("方案已提交")),
    ]);
    const task = await createPlanGatedTask("验收关口联调任务");
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_plan_approval");

    const planApproval = container.approvals
      .list("pending")
      .find((a) => a.kind === "plan" && (a.payload as { taskId?: string }).taskId === task.id)!;
    await call(`/approvals/${planApproval.id}`, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    });
    await waitFor(() => container.tasks.get(task.id)?.status === "running");

    faux.setResponses([fauxAssistantMessage(fauxText("已完成实施与自测"))]);
    const followup = await json<{ id: string }>(`/tasks/${task.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger: "followup", message: "开始实施" }),
    });
    await waitFor(() => container.tasks.getRun(followup.id)?.status === "succeeded");
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");

    const reviewApproval = container.approvals
      .list("pending")
      .find((a) => a.kind === "review" && (a.payload as { taskId?: string }).taskId === task.id);
    expect(reviewApproval).toBeDefined();

    const res = await call(`/tasks/${task.id}/review`, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);
    expect(container.tasks.get(task.id)!.status).toBe("completed");
  });

  it("POST /tasks/:id/review 懒创建兜底：没有主动创建 review 审批的任务也能正常验收", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("简单任务直接完成"))]);
    const task = await json<{ id: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "普通任务（无方案关口）" }),
    });
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");
    // 普通任务（requiresPlanApproval=false）不会主动创建 review 审批。
    expect(
      container.approvals
        .list("pending")
        .find((a) => a.kind === "review" && (a.payload as { taskId?: string }).taskId === task.id),
    ).toBeUndefined();

    const res = await call(`/tasks/${task.id}/review`, {
      method: "POST",
      body: JSON.stringify({ approved: false, outcome: "abandon" }),
    });
    expect(res.status).toBe(200);
    expect(container.tasks.get(task.id)!.status).toBe("failed");
  });
});

describe("reviewer Agent 占位：定义存在、可按需调用，不自动触发", () => {
  it("orchestrator.runSpecialist('reviewer', ...) 能直接成功调用（用 faux provider 验证定义可用）", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("审查结论：方案清晰，pass"))]);

    const result = await container.orchestrator.runSpecialist(
      "reviewer",
      [{ role: "user", content: "请审阅这份方案", timestamp: Date.now() }],
      "请审阅这份方案",
      {
        emit: () => {},
        requestApproval: async () => true,
      },
    );

    expect(result.text).toContain("pass");
  });

  it("tasks.recordReviewSummary 能正常落一条 kind='summary' 的产物", async () => {
    const task = container.tasks.create({
      goal: "审查摘要落库测试",
      conversationId: "conv-review-summary-test",
      requiresPlanApproval: false,
    });
    const run = container.tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "create",
      input: { userMessage: "测试" },
    });

    const artifact = container.tasks.recordReviewSummary(task.id, run.id, "审查结论：通过");
    expect(artifact.kind).toBe("summary");
    expect(artifact.content).toBe("审查结论：通过");
    expect(container.tasks.listArtifacts(task.id, "summary")).toHaveLength(1);
  });
});
