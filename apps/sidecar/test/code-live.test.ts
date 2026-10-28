import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { fsRead } from "@agentdesk/integrations";
import type { Artifact, RunEventRecord, Task } from "@agentdesk/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { createApp } from "../src/http/app";

let container: Container;
let faux: FauxProviderRegistration;
let project: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdesk-code-live-"));
  project = mkdtempSync(join(tmpdir(), "agentdesk-code-project-"));
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  container = await createContainer(
    { ...loadConfig({ AGENTDESK_DATA_DIR: dir }), token: "test-token" },
    { inMemory: true },
  );
  await container.projects.add(project);
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "x" },
  ];
});
afterAll(async () => {
  faux.unregister();
  await container.dispose();
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待编码任务超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(toWireName(name), args), { stopReason: "toolUse" });
const request = (path: string, body?: unknown) =>
  createApp(container).request(`/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "test-token" },
    body: body ? JSON.stringify(body) : undefined,
  });

it("实际修改项目：审批前不落盘，审批后差异、命令输出和运行记录可查询", async () => {
  writeFileSync(join(project, "main.ts"), "export const count = 1;\n");
  const { hash } = await fsRead(project, "main.ts");
  faux.setResponses([
    tool("fs.read", { project, path: "main.ts" }),
    tool("fs.patch", {
      project,
      path: "main.ts",
      oldText: "count = 1",
      newText: "count = 2",
      expectedHash: hash,
    }),
    tool("shell.run", {
      cwd: project,
      command: "node -e \"console.log('verification complete')\"",
    }),
    fauxAssistantMessage(fauxText("修改完成，验证已通过。")),
  ]);
  const task = (await (
    await request("/tasks", { goal: "修复 count", agent: "code" })
  ).json()) as Task;
  await waitFor(() => container.approvals.list("pending").length > 0);
  expect(container.tasks.get(task.id)?.status).toBe("running");
  expect(readFileSync(join(project, "main.ts"), "utf8")).toContain("count = 1");
  expect(container.tasks.listArtifacts(task.id)).toHaveLength(0);
  await request(`/approvals/${container.approvals.list("pending")[0]!.id}`, { approved: true });
  await waitFor(() => container.approvals.list("pending").length > 0);
  await request(`/approvals/${container.approvals.list("pending")[0]!.id}`, { approved: true });
  await waitFor(() => container.tasks.get(task.id)?.status === "awaiting_review");
  expect(readFileSync(join(project, "main.ts"), "utf8")).toContain("count = 2");
  const events = (await (
    await request(`/tasks/${task.id}/events?limit=500`)
  ).json()) as RunEventRecord[];
  expect(
    events.some(
      (e) =>
        e.event.type === "file_change" && e.event.change.diff.includes("+export const count = 2;"),
    ),
  ).toBe(true);
  expect(
    events.some(
      (e) => e.event.type === "tool_output" && e.event.delta.includes("verification complete"),
    ),
  ).toBe(true);
  const artifacts = (await (await request(`/tasks/${task.id}/artifacts`)).json()) as Artifact[];
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0]?.content).toContain("-export const count = 1;");
  expect(await (await request(`/tasks/${task.id}/runs`)).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "succeeded" })]),
  );
  expect(
    await (await request(`/tasks/${task.id}/events?after=${events.at(-1)!.seq}`)).json(),
  ).toEqual([]);
});

it("聊天产生可观察的运行，拒绝编辑不会生成成功差异", async () => {
  faux.setResponses([
    tool("fs.write", { project, path: "rejected.ts", content: "bad", expectedHash: "" }),
    fauxAssistantMessage(fauxText("用户拒绝了修改。")),
    fauxAssistantMessage(fauxText('{"memories":[]}')),
  ]);
  const response = await request("/chat", { message: "创建拒绝测试文件", agent: "code" });
  const text = response.text();
  await waitFor(() => container.approvals.list("pending").length > 0);
  const task = container.tasks.list().find((t) => t.goal === "创建拒绝测试文件")!;
  expect(task.status).toBe("running");
  expect(container.tasks.listRuns(task.id)[0]?.status).toBe("running");
  await request(`/approvals/${container.approvals.list("pending")[0]!.id}`, { approved: false });
  await text;
  expect(container.tasks.get(task.id)?.status).toBe("awaiting_review");
  expect(container.tasks.listArtifacts(task.id)).toHaveLength(0);
  const events = container.tasks.eventsAfter({ taskId: task.id, after: 0, limit: 500 });
  expect(events.map((e) => e.event.type)).toEqual(
    expect.arrayContaining(["run_started", "approval_required", "run_ended"]),
  );
  expect(events.some((e) => e.event.type === "file_change")).toBe(false);
});
