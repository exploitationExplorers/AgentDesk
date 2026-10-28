import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorRunOptions } from "@agentdesk/agent-core";
import type { Run, Task } from "@agentdesk/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

let container: Container;
let projectA: string;
let projectB: string;
const seen: OrchestratorRunOptions[] = [];
beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agentdesk-context-data-"));
  projectA = await mkdtemp(join(tmpdir(), "agentdesk-context-a-"));
  projectB = await mkdtemp(join(tmpdir(), "agentdesk-context-b-"));
  for (const root of [projectA, projectB])
    execFileSync("git", ["init", root], { windowsHide: true, stdio: "ignore" });
  await writeFile(join(projectA, "AGENTS.md"), "unique-a-rule");
  await writeFile(join(projectB, "CLAUDE.md"), "unique-b-rule");
  container = await createContainer(
    { ...loadConfig({ AGENTDESK_DATA_DIR: dataDir }), token: "test" },
    { inMemory: true },
  );
  await container.projects.add(projectA);
  await container.projects.add(projectB);
  vi.spyOn(container.orchestrator, "run").mockImplementation(async (options) => {
    seen.push(options);
    return { text: "done", agent: "code", toolCalls: [] };
  });
  vi.spyOn(container.memory, "captureFromTurn").mockResolvedValue([]);
});
afterAll(async () => {
  vi.restoreAllMocks();
  await container.dispose();
});

const post = (path: string, body: unknown) =>
  createApp(container).request(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "test" },
    body: JSON.stringify(body),
  });

async function waitForTask(id: string) {
  await vi.waitFor(() => expect(container.tasks.get(id)?.status).toBe("awaiting_review"));
}

it("不同项目任务各自注入规则，续跑和子 Run 继承所属工作区", async () => {
  const [a, b] = await Promise.all([
    post("/tasks", { goal: "context-a", agent: "code", workspace: projectA }),
    post("/tasks", { goal: "context-b", agent: "code", workspace: projectB }),
  ]);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const taskA = (await a.json()) as Task;
  const taskB = (await b.json()) as Task;
  await Promise.all([waitForTask(taskA.id), waitForTask(taskB.id)]);
  expect(seen.find((item) => item.userMessage === "context-a")?.context).toContain("unique-a-rule");
  expect(seen.find((item) => item.userMessage === "context-a")?.context).not.toContain(
    "unique-b-rule",
  );
  expect(seen.find((item) => item.userMessage === "context-b")?.context).toContain("unique-b-rule");
  const continued = await post(`/tasks/${taskA.id}/runs`, {
    trigger: "followup",
    message: "context-a-next",
  });
  const run = (await continued.json()) as Run;
  expect(run.input.workspace).toBe(projectA);
  await waitForTask(taskA.id);
  expect(seen.find((item) => item.userMessage === "context-a-next")?.context).toContain(
    "unique-a-rule",
  );
  const child = container.tasks.createRun({
    taskId: taskA.id,
    parentRunId: run.id,
    kind: "delegate",
    agent: "code",
    trigger: "delegate",
    input: { userMessage: "child" },
  });
  expect(child.input.workspace).toBe(projectA);
});

it("聊天也加载规则，后续对话未重复提供工作区时沿用对应 Run", async () => {
  let conversationId = "";
  await container.chat.send(
    { message: "chat-a", agent: "code", workspace: projectA },
    (event) => {
      if (event.type === "conversation") conversationId = event.conversationId;
    },
    new AbortController().signal,
  );
  await container.chat.send(
    { message: "chat-a-next", agent: "code", conversationId },
    () => {},
    new AbortController().signal,
  );
  expect(seen.find((item) => item.userMessage === "chat-a")?.context).toContain("unique-a-rule");
  expect(seen.find((item) => item.userMessage === "chat-a-next")?.context).toContain(
    "unique-a-rule",
  );
  const previous = container.tasks.findByConversation(conversationId)!;
  container.tasks.transition(previous.id, "completed");
  await container.chat.send(
    { message: "chat-after-completed", agent: "code", conversationId },
    () => {},
    new AbortController().signal,
  );
  expect(seen.find((item) => item.userMessage === "chat-after-completed")?.context).toContain(
    "unique-a-rule",
  );
});

it("未注册工作区在创建任务之前失败，坏规则让运行失败且不调用模型", async () => {
  const before = container.tasks.list().length;
  const invalid = await post("/tasks", { goal: "invalid-root", workspace: tmpdir() });
  expect(invalid.status).toBe(400);
  expect(container.tasks.list()).toHaveLength(before);
  const invalidChat = await post("/chat", { message: "invalid-chat-root", workspace: tmpdir() });
  expect(invalidChat.status).toBe(400);
  await writeFile(join(projectB, "AGENTS.md"), "x".repeat(32 * 1024 + 1));
  const response = await post("/tasks", { goal: "bad-instructions", workspace: projectB });
  const task = (await response.json()) as Task;
  await vi.waitFor(() => expect(container.tasks.get(task.id)?.status).toBe("failed"));
  expect(container.tasks.listRuns(task.id)[0]?.resultError).toContain("32 KiB");
  expect(seen.some((item) => item.userMessage === "bad-instructions")).toBe(false);
});
