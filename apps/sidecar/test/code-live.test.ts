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
import type { AgentStreamEvent, Artifact, RunEventRecord, Task } from "@agentdesk/shared";
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

it("提交前的组合 Git 查询无需审批，实际提交仅在批准后执行", async () => {
  const repo = mkdtempSync(join(tmpdir(), "agentdesk-git-approval-"));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd: repo, windowsHide: true, encoding: "utf8" },
    );
  git(["init"]);
  writeFileSync(join(repo, "example file.txt"), "before\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  const before = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "example file.txt"), "after\n");
  await container.projects.add(repo);
  const query =
    "git status --short; git branch --show-current; git rev-parse HEAD; git diff --stat; git diff --cached --stat; git ls-files --others --exclude-standard";
  const commit =
    'git add -- "example file.txt" && git -c user.name=Test -c user.email=test@example.invalid commit -m "update fixture"';
  const approvalCount = container.approvals.list().length;
  faux.setResponses([
    tool("shell.run", { cwd: repo, command: query }),
    tool("shell.run", {
      cwd: repo,
      command: 'git -c core.safecrlf=false diff -- "example file.txt"',
    }),
    tool("shell.run", {
      cwd: repo,
      command: "git rev-parse --verify missing-ref || git diff --stat",
    }),
    tool("shell.run", { cwd: repo, command: commit }),
    tool("shell.run", { cwd: repo, command: "git rev-parse HEAD && git status --short" }),
    fauxAssistantMessage(fauxText("已完成本地提交。")),
    fauxAssistantMessage(fauxText('{"memories":[]}')),
  ]);
  const response = await request("/chat", {
    message: "提交临时项目",
    agent: "code",
    workspace: repo,
  });
  const stream = response.text();
  await waitFor(() => container.approvals.list("pending").length > 0);
  const pending = container.approvals.list("pending");
  expect(pending).toHaveLength(1);
  expect(pending[0]!.title).toContain(commit);
  expect(git(["rev-parse", "HEAD"]).trim()).toBe(before);
  await request(`/approvals/${pending[0]!.id}`, { approved: true });
  const events = await stream;
  expect(events).toContain("+after");
  expect(events).toContain(before);
  expect(container.approvals.list().length - approvalCount).toBe(1);
  expect(git(["rev-parse", "HEAD"]).trim()).not.toBe(before);
  expect(git(["status", "--short"]).trim()).toBe("");
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

for (const decision of ["approve", "reject", "cancel"] as const) {
  it(`聊天委派的文件编辑在当前 SSE 显示审批并支持 ${decision}`, async () => {
    const path = `delegated-${decision}.ts`;
    const original = "export const count = 1;\n";
    writeFileSync(join(project, path), original);
    const { hash } = await fsRead(project, path);
    faux.setResponses([
      tool("agents.delegate", { agent: "code", task: `修改 ${path}` }),
      tool("fs.read", { project, path }),
      tool("fs.patch", {
        project,
        path,
        oldText: "count = 1",
        newText: "count = 2",
        expectedHash: hash,
      }),
      fauxAssistantMessage(fauxText("子任务已处理。")),
      fauxAssistantMessage(fauxText("总控已完成。")),
      fauxAssistantMessage(fauxText('{"memories":[]}')),
    ]);
    const response = await request("/chat", { message: `委派编辑 ${path}`, workspace: project });
    const reader = response.body!.getReader();
    const events: AgentStreamEvent[] = [];
    const consume = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const records = buffer.split("\n\n");
        buffer = records.pop()!;
        for (const record of records) {
          const data = record.split("\n").find((line) => line.startsWith("data:"));
          if (data) events.push(JSON.parse(data.slice(5)) as AgentStreamEvent);
        }
      }
    })();
    try {
      await waitFor(() => container.approvals.list("pending").length > 0);
      expect(readFileSync(join(project, path), "utf8")).toBe(original);
      // 只通过当前聊天流接收审批，不能用后台审批列表替终端绕过缺失的事件。
      await expect
        .poll(() => events.some((event) => event.type === "approval_required"), { timeout: 1000 })
        .toBe(true);
      const approval = events.find((event) => event.type === "approval_required")!;
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool_call", agent: "code", name: "fs.read" }),
          expect.objectContaining({ type: "tool_call", agent: "code", name: "fs.patch" }),
        ]),
      );
      if (decision === "cancel") await reader.cancel();
      else await request(`/approvals/${approval.approvalId}`, { approved: decision === "approve" });
      await consume;
      const task = container.tasks.list().find((item) => item.goal === `委派编辑 ${path}`)!;
      await waitFor(() =>
        container.tasks.listRuns(task.id).every((run) => run.status !== "running"),
      );
      expect(readFileSync(join(project, path), "utf8")).toBe(
        decision === "approve" ? original.replace("count = 1", "count = 2") : original,
      );
      expect(container.approvals.list("pending")).toHaveLength(0);
      const records = container.tasks.eventsAfter({ taskId: task.id, after: 0, limit: 500 });
      const approvals = records.filter((record) => record.event.type === "approval_required");
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.parentRunId).not.toBeNull();
      expect(container.tasks.listArtifacts(task.id)).toHaveLength(decision === "approve" ? 1 : 0);
      if (decision === "cancel") {
        expect(container.tasks.listRuns(task.id).every((run) => run.status === "cancelled")).toBe(
          true,
        );
      } else {
        expect(events.filter((event) => event.type === "done")).toHaveLength(1);
        expect(events.filter((event) => event.type === "file_change")).toHaveLength(
          decision === "approve" ? 1 : 0,
        );
        expect(events.some((event) => event.type === "error")).toBe(false);
      }
    } finally {
      for (const approval of container.approvals.list("pending")) {
        container.approvals.resolve(approval.id, false);
      }
      await consume;
      reader.releaseLock();
    }
  });
}
