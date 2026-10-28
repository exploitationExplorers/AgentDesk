import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type Context,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EventHub } from "../src/events";
import { createApp } from "../src/http/app";
import { ApprovalService } from "../src/services/approvals";

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
  const dataDir = mkdtempSync(join(tmpdir(), "agentdesk-task-followup-"));
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

describe("tasks.ask_user 追问阻塞与回答", () => {
  it("模型调用 tasks.ask_user 后阻塞，经过两次审批（执行门禁 + 回答问题）后拿到回答文本继续推理", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.ask_user"), { question: "请提供数据库密码" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("已确认，继续执行")),
    ]);

    const task = await json<{ id: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "需要澄清的任务" }),
    });

    // 第一次审批：executeToolCall 对 risk!=='safe' 工具的通用执行门禁（kind='tool'）。
    await waitFor(() => container.approvals.list("pending").length >= 1);
    const gate = container.approvals.list("pending")[0]!;
    expect(gate.kind).toBe("tool");
    const gateRes = await call(`/approvals/${gate.id}`, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    });
    expect(gateRes.status).toBe(200);

    // 第二次审批：ask_user 内部通过 ctx.requestAnswer 创建的 kind='question' 审批，承载真正的问题。
    await waitFor(() => container.approvals.list("pending").length >= 1);
    const question = container.approvals.list("pending")[0]!;
    expect(question.kind).toBe("question");
    expect(question.detail).toBe("请提供数据库密码");
    const answerRes = await call(`/approvals/${question.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ text: "密码是 s3cr3t" }),
    });
    expect(answerRes.status).toBe(200);
    expect((await answerRes.json()) as { status: string }).toMatchObject({ status: "approved" });

    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");
    const [run] = container.tasks.listRuns(task.id);
    expect(run!.status).toBe("succeeded");
    expect(run!.resultText).toBe("已确认，继续执行");

    const askCall = (run!.toolCalls as Array<{
      name: string;
      result: unknown;
      isError: boolean;
    }>)!.find((c) => c.name === "tasks.ask_user");
    expect(askCall?.isError).toBe(false);
    expect(askCall?.result).toBe("密码是 s3cr3t");
  });

  it("追问被拒绝时工具执行失败，Run 仍能正常结束（不会无限阻塞）", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("tasks.ask_user"), { question: "需要你确认一下" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("好吧，那我先不继续了")),
    ]);

    const task = await json<{ id: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "会被拒绝的追问" }),
    });

    await waitFor(() => container.approvals.list("pending").length >= 1);
    const gate = container.approvals.list("pending")[0]!;
    expect(gate.kind).toBe("tool");
    await call(`/approvals/${gate.id}`, {
      method: "POST",
      body: JSON.stringify({ approved: true }),
    });

    await waitFor(() => container.approvals.list("pending").length >= 1);
    const question = container.approvals.list("pending")[0]!;
    expect(question.kind).toBe("question");
    await call(`/approvals/${question.id}`, {
      method: "POST",
      body: JSON.stringify({ approved: false }),
    });

    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");
    const [run] = container.tasks.listRuns(task.id);
    expect(run!.status).toBe("succeeded");
    const askCall = (run!.toolCalls as Array<{ name: string; isError: boolean }>)!.find(
      (c) => c.name === "tasks.ask_user",
    );
    expect(askCall?.isError).toBe(true);
  });
});

describe("resume：续跑拼装上次失败摘要", () => {
  it("trigger='resume' 时，orchestrator.run 收到的 system prompt 包含上次失败的工具调用与错误摘要", async () => {
    const task = container.tasks.create({
      goal: "续跑测试",
      conversationId: "conv-resume-test",
      requiresPlanApproval: false,
    });
    const failedRun = container.tasks.createRun({
      taskId: task.id,
      kind: "root",
      agent: "orchestrator",
      trigger: "create",
      input: { userMessage: "第一次尝试" },
    });
    container.tasks.transition(task.id, "queued");
    container.tasks.transition(task.id, "running");
    container.tasks.finalizeRunDirect(failedRun.id, {
      status: "failed",
      resultError: "连接数据库超时",
      toolCalls: [
        {
          id: "c1",
          name: "shell.run",
          args: { command: "echo hi" },
          result: "hi",
          isError: false,
          agent: "orchestrator",
        },
      ],
    });
    expect(container.tasks.get(task.id)!.status).toBe("failed");

    let capturedSystemPrompt = "";
    faux.setResponses([
      (context: Context) => {
        capturedSystemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage(fauxText("继续执行完成"));
      },
    ]);

    const resumeRun = await json<{ id: string }>(`/tasks/${task.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger: "resume", message: "继续" }),
    });

    await waitFor(() => container.tasks.getRun(resumeRun.id)?.status === "succeeded");

    expect(capturedSystemPrompt).toContain("连接数据库超时");
    expect(capturedSystemPrompt).toContain("shell.run");
  });
});

describe("幂等：HTTP 层重复请求只产生一条 Run", () => {
  it("POST /tasks/:id/runs 带同一个 idempotencyKey 连续调用两次，只产生一条新 Run", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("创建任务的首次响应"))]);
    const task = await json<{ id: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "幂等测试任务" }),
    });
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");

    const key = "idem-followup-key-1";
    faux.setResponses([fauxAssistantMessage(fauxText("追加指令的响应"))]);
    const run1 = await json<{ id: string }>(`/tasks/${task.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger: "followup", message: "追加指令", idempotencyKey: key }),
    });
    await waitFor(() => container.tasks.getRun(run1.id)?.status === "succeeded");

    const run2 = await json<{ id: string }>(`/tasks/${task.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger: "followup", message: "追加指令", idempotencyKey: key }),
    });

    expect(run2.id).toBe(run1.id);
    expect(container.tasks.listRuns(task.id).length).toBe(2);
  });

  it("POST /tasks 带 idempotencyKey 时会正确透传到创建的 Run 上", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("带幂等键创建任务的响应"))]);
    const key = "idem-create-key-1";
    const task = await json<{ id: string }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal: "带幂等键的任务", idempotencyKey: key }),
    });
    await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");
    const [run] = container.tasks.listRuns(task.id);
    expect(run!.idempotencyKey).toBe(key);
  });
});

describe("ApprovalService.answer 幂等语义", () => {
  let handle: DbHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
  });

  it("已经被 resolve 过的审批再次调用 answer 是 no-op：不报错、不改变状态与 payload", () => {
    handle = openDatabase(":memory:");
    const approvals = new ApprovalService(handle.db, new EventHub());
    const { approval } = approvals.create({
      kind: "question",
      title: "需要你补充信息",
      detail: "问题",
      risk: "confirm",
      payload: { kind: "question", question: "问题" },
    });

    const rejected = approvals.resolve(approval.id, false);
    expect(rejected.status).toBe("rejected");

    const afterAnswer = approvals.answer(approval.id, "迟来的回答");
    expect(afterAnswer.status).toBe("rejected");
    expect(afterAnswer.payload).toEqual(approval.payload);
  });

  it("pending 状态下 answer 把回答写入 payload 并等价于 approve", () => {
    handle = openDatabase(":memory:");
    const approvals = new ApprovalService(handle.db, new EventHub());
    const { approval } = approvals.create({
      kind: "question",
      title: "需要你补充信息",
      detail: "问题",
      risk: "confirm",
      payload: { kind: "question", question: "问题" },
    });

    const answered = approvals.answer(approval.id, "我的回答");
    expect(answered.status).toBe("approved");
    expect(answered.payload).toMatchObject({ answer: "我的回答" });
  });
});
