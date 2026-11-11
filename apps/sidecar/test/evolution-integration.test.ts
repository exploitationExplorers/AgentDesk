import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

let container: Container;
let app: ReturnType<typeof createApp>;
let faux: FauxProviderRegistration;
const token = "evolution-integration-test-token";

beforeAll(async () => {
  container = await createContainer(
    {
      ...loadConfig({ AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-evolution-")) }),
      token,
    },
    { inMemory: true },
  );
  app = createApp(container);
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  vi.spyOn(container.providers, "resolve").mockImplementation(async () => [
    {
      providerId: "fixture",
      providerName: "fixture",
      model: faux.getModel(),
      apiKey: "synthetic-fixture-key",
    },
  ]);
  container.memory.updatePolicy({ autoCaptureEnabled: false });
});

afterAll(async () => {
  faux?.unregister();
  await container?.dispose();
  vi.restoreAllMocks();
});

async function request(path: string, method = "GET", body?: unknown) {
  return app.request(`/api${path}`, {
    method,
    headers: { "X-AgentDesk-Token": token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("完整容器接通认证、候选、隔离记忆回归与发布拒绝", async () => {
  expect((await app.request("/api/evolution")).status).toBe(401);
  const overview = await request("/evolution");
  expect(overview.status).toBe(200);
  expect((await overview.json()).activeVersion.id).toBe("baseline-v1");
  const created = await request("/evolution/proposals", "POST", {
    title: "先验证",
    instructions: "执行后先核实产物和测试结果，再报告完成。",
  });
  expect(created.status).toBe(200);
  const candidate = await created.json();
  const evaluated = await request(`/evolution/proposals/${candidate.id}/evaluate`, "POST", {
    mode: "memory",
  });
  expect(evaluated.status).toBe(200);
  const result = await evaluated.json();
  expect(result.status).toBe("completed");
  expect(result.cases.length).toBeGreaterThanOrEqual(30);
  expect(result.candidatePassed).toBe(result.expectedCaseCount);
  expect(result.eligibleForRelease).toBe(false);
  expect(
    (
      await request(`/evolution/proposals/${candidate.id}/publish`, "POST", {
        evaluationId: result.id,
      })
    ).status,
  ).toBe(409);
  expect((await request(`/evaluations/${result.id}`)).status).toBe(200);
  expect((await request("/evaluations", "POST", { eligibleForRelease: true })).status).toBe(404);
});

it("服务器解析可信版本，拒绝客户端伪造基线、未授权模型评测与非法JSON", async () => {
  const candidate = await (
    await request("/evolution/proposals", "POST", {
      title: "检查失败",
      instructions: "工具失败时先说明失败原因并核实当前状态。",
    })
  ).json();
  expect(
    (
      await request(`/evolution/proposals/${candidate.id}/evaluate`, "POST", {
        mode: "memory",
        baseline: { id: "forged", instructions: "forged" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(`/evolution/proposals/${candidate.id}/evaluate`, "POST", { mode: "agent" }))
      .status,
  ).toBe(400);
  expect(
    (await request("/evolution/proposals/generate", "POST", { evidenceRunIds: ["missing"] }))
      .status,
  ).toBe(400);
  const malformed = await app.request("/api/evolution/proposals", {
    method: "POST",
    headers: { "X-AgentDesk-Token": token, "Content-Type": "application/json" },
    body: "{",
  });
  expect(malformed.status).toBe(400);
});

it("记忆候选经认证管理接口审核、更正和遗忘，不污染默认召回", async () => {
  const stored = container.memory.store({
    text: "用户偏好深色主题",
    kind: "preference",
    source: "auto",
  }).memory;
  expect(container.memory.recall("深色主题")).toEqual([]);
  expect((await request(`/memories/${stored.id}/approve`, "POST")).status).toBe(200);
  expect(container.memory.recall("深色主题").map((memory) => memory.id)).toContain(stored.id);
  const corrected = await (
    await request(`/memories/${stored.id}`, "PUT", { text: "用户偏好浅色主题" })
  ).json();
  expect(corrected.supersedesId).toBe(stored.id);
  expect((await request(`/memories/${corrected.id}`, "DELETE")).status).toBe(200);
  expect(container.memory.recall("浅色主题")).toEqual([]);
  expect((await request("/memories/policy")).status).toBe(200);
});

it("真实聊天固定行为版本到Run，并可提交反馈作为后续候选证据", async () => {
  faux.setResponses([fauxAssistantMessage(fauxText("本次使用合成模型完成验证。"))]);
  const conversationId = await container.chat.send(
    { message: "简单说明这次验证结果", agent: "code" },
    () => undefined,
    new AbortController().signal,
  );
  const task = container.tasks.findByConversation(conversationId);
  expect(task).toBeDefined();
  const runId = task!.currentRunId!;
  const pinned = container.dbHandle.raw
    .prepare("SELECT version_id FROM run_behaviors WHERE run_id = ?")
    .get(runId);
  expect(pinned).toEqual({ version_id: "baseline-v1" });
  const feedback = await request("/evolution/feedback", "POST", {
    runId,
    rating: "unhelpful",
    note: "没有说明验证依据，需要更清楚的结果。",
  });
  expect(feedback.status).toBe(200);
  const evidence = await (await request("/evolution/evidence")).json();
  expect(evidence.some((item: { runId: string }) => item.runId === runId)).toBe(true);
  const fromFeedback = await request("/evolution/proposals", "POST", {
    title: "补充依据",
    instructions: "报告测试结果时注明验证方式和实际执行结果。",
    evidenceRunIds: [runId],
  });
  expect(fromFeedback.status).toBe(200);
  faux.setResponses([
    fauxAssistantMessage(
      fauxText(
        JSON.stringify({
          title: "先验证再总结",
          instructions: "报告完成前核实工具结果，并说明已执行的验证和仍未验证的部分。",
        }),
      ),
    ),
  ]);
  const generated = await request("/evolution/proposals/generate", "POST", {
    evidenceRunIds: [runId],
    allowModelCalls: true,
  });
  expect(generated.status).toBe(200);
  const proposal = await generated.json();
  expect(proposal.status).toBe("draft");
  expect(proposal.baseVersionId).toBe("baseline-v1");
  expect(proposal.evidenceRunIds).toEqual([runId]);
  expect(proposal.instructions).toContain("核实工具结果");
  expect(container.evolution.active().id).toBe("baseline-v1");
  expect(container.evolution.proposal(proposal.id)).toEqual(proposal);
});
