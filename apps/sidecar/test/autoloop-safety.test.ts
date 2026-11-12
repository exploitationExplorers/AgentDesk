import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import {
  DURABLE_EXECUTOR_VERSION,
  toWireName,
  type DurableCheckpoint,
} from "@agentdesk/agent-core";
import { afterEach, expect, it, vi } from "vitest";
import { AppError, ErrorCode } from "@agentdesk/shared";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { openDatabase } from "../src/db/client";
import { AutoloopStore } from "../src/services/autoloop/store";
let container: Container | undefined;
let faux: FauxProviderRegistration | undefined;
const roots: string[] = [];
afterEach(async () => {
  await container?.dispose();
  container = undefined;
  faux?.unregister();
  faux = undefined;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function waitFor(predicate: () => boolean | Promise<boolean>, description: string) {
  const end = Date.now() + 20000;
  while (!(await predicate())) {
    if (Date.now() > end)
      throw new Error(`等待超时：${description}; ${JSON.stringify(await container?.tasks.list())}`);
    await container?.autoloop.tick();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-autoloop-safety-"));
  roots.push(root);
  const workspace = join(root, "项目 空格");
  mkdirSync(workspace);
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  const config = loadConfig({ AGENTDESK_DATA_DIR: join(root, "data") });
  container = await createContainer(config);
  faux = registerFauxProvider({ tokensPerSecond: 100000 });
  const connect = () => {
    container!.providers.resolve = async () => [
      { providerId: "faux", providerName: "faux", model: faux!.getModel(), apiKey: "test" },
    ];
  };
  connect();
  const project = await container.projects.add(workspace);
  const binding = await container.autoloop.createBinding({
    title: "安全验证",
    goal: "按要求生成报告",
    projectId: project.id,
    workspacePolicy: { root: workspace, allowSubdirectories: false },
    maxRounds: 20,
    maxMinutes: 5,
  });
  return { workspace, config, connect, project, binding };
}
const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(toWireName(name), args), { stopReason: "toolUse" });
it("真实 Hub：空间不足时保留任务并停止模型与工具执行", async () => {
  const { workspace, binding, project } = await setup();
  const check = vi
    .spyOn(container!.storage, "assertWritable")
    .mockRejectedValue(new AppError(ErrorCode.StorageFull, "磁盘可用空间低于预留值"));
  const execute = vi.spyOn(
    container!.registry.list().find((item) => item.name === "fs.write")!,
    "execute",
  );
  faux!.setResponses([
    tool("fs.write", { project: project.id, path: "blocked.txt", content: "不得写入" }),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "storage-full" });
  await waitFor(
    async () =>
      (await container!.tasks.list()).some((task) => task.automationStatus === "needs_attention"),
    "磁盘准入失败",
  );
  expect(check).toHaveBeenCalledWith(workspace);
  expect(faux!.state.callCount).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  expect(existsSync(join(workspace, "blocked.txt"))).toBe(false);
  const task = (await container!.tasks.list())[0]!;
  expect((await container!.tasks.listRuns(task.id))[0]?.resultError).toContain("预留值");
});
it("真实 Hub：授权恢复遇到低空间时保留检查点，恢复容量后继续一次", async () => {
  const { workspace, binding, project } = await setup();
  const execute = vi.spyOn(
    container!.registry.list().find((item) => item.name === "fs.write")!,
    "execute",
  );
  faux!.setResponses([
    tool("fs.write", { project: project.id, path: "after-recovery.txt", content: "恢复后写入" }),
    fauxAssistantMessage(fauxText("完成")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "storage-recovery" });
  await waitFor(
    () => container!.autoloop.listInteractions().some((card) => card.state === "open"),
    "请求授权",
  );
  const card = container!.autoloop.listInteractions().find((card) => card.state === "open")!;
  const store = new AutoloopStore(container!.dbHandle.db);
  const checkpoint = store.checkpoints.get(card.taskId!)!.checkpoint;
  const check = vi
    .spyOn(container!.storage, "assertWritable")
    .mockRejectedValue(new AppError(ErrorCode.StorageFull, "磁盘可用空间低于预留值"));
  await container!.autoloop.answerInteraction(card.id, {
    cardVersion: card.version,
    answerId: "approved",
    choice: 0,
  });
  await waitFor(
    async () => (await container!.tasks.get(card.taskId!))?.automationStatus === "needs_attention",
    "磁盘阻止续跑",
  );
  expect(store.checkpoints.get(card.taskId!)!.checkpoint).toEqual(checkpoint);
  expect(execute).not.toHaveBeenCalled();
  expect(faux!.state.callCount).toBe(1);
  check.mockRestore();
  await container!.autoloop.resumeTask(card.taskId!);
  await waitFor(
    async () => (await container!.tasks.get(card.taskId!))?.automationStatus === "completed",
    "磁盘恢复后续跑",
  );
  expect(readFileSync(join(workspace, "after-recovery.txt"), "utf8")).toBe("恢复后写入");
  expect(execute).toHaveBeenCalledOnce();
}, 40000);
it("真实 Hub：授权等待期间新增拒绝规则，恢复前阻止写入", async () => {
  const { workspace, binding, project } = await setup();
  const execute = vi.spyOn(
    container!.registry.list().find((item) => item.name === "fs.write")!,
    "execute",
  );
  faux!.setResponses([
    tool("fs.write", { project: project.id, path: "restricted.txt", content: "不得写入" }),
    fauxAssistantMessage(fauxText("完成")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "permission-change" });
  await waitFor(
    () => container!.autoloop.listInteractions().some((card) => card.state === "open"),
    "请求授权",
  );
  const card = container!.autoloop.listInteractions().find((item) => item.state === "open")!;
  expect(card.interactionKind).toBe("authorization");
  expect((await container!.tasks.get(card.taskId!))?.automationStatus).toBe(
    "waiting_authorization",
  );
  container!.permissionRules.add("fs.write", "restricted.txt", "deny");
  await container!.autoloop.answerInteraction(card.id, {
    cardVersion: card.version,
    answerId: "approved",
    choice: 0,
  });
  await waitFor(
    async () => (await container!.tasks.get(card.taskId!))?.automationStatus === "needs_attention",
    "重新校验拒绝规则",
  );
  expect(execute).not.toHaveBeenCalled();
  expect(existsSync(join(workspace, "restricted.txt"))).toBe(false);
  expect(faux!.state.callCount).toBe(1);
}, 40000);
it("真实 Hub：写入后异常保留不明结果，重启与手动恢复都不重做", async () => {
  const { workspace, config, connect, project, binding } = await setup();
  container!.permissionRules.add("fs.write", "written-once.txt");
  const write = container!.registry.list().find((item) => item.name === "fs.write")!;
  const original = write.execute;
  const execute = vi.spyOn(write, "execute").mockImplementation(async (args, context) => {
    await original(args, context);
    throw new Error("模拟写入完成后响应失败");
  });
  faux!.setResponses([
    tool("fs.write", { project: project.id, path: "written-once.txt", content: "已经落盘" }),
    fauxAssistantMessage(fauxText("不能继续")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "unknown-result" });
  await waitFor(
    async () =>
      (await container!.autoloop.listTasks(binding.id)).some(
        (task) => task.automationStatus === "needs_attention",
      ),
    "不明执行结果",
  );
  const task = (await container!.autoloop.listTasks(binding.id))[0]!;
  const store = new AutoloopStore(container!.dbHandle.db);
  expect(store.checkpoints.get(task.id)?.checkpoint.phase).toBe("unknown");
  expect(readFileSync(join(workspace, "written-once.txt"), "utf8")).toBe("已经落盘");
  expect(execute).toHaveBeenCalledOnce();
  await container!.dispose();
  container = undefined;
  container = await createContainer(config);
  connect();
  const afterRestart = vi.spyOn(
    container.registry.list().find((item) => item.name === "fs.write")!,
    "execute",
  );
  await container.autoloop.tick();
  await expect(container.autoloop.resumeTask(task.id)).rejects.toThrow(/不能自动重做/);
  expect(afterRestart).not.toHaveBeenCalled();
  expect(faux!.state.callCount).toBe(1);
  expect(await container.tasks.listRuns(task.id)).toHaveLength(1);
}, 40000);
it("真实 Hub：停止等待事项关闭卡片并拒绝旧回答", async () => {
  const { binding } = await setup();
  faux!.setResponses([
    tool("tasks.ask_user", { question: "选择报告范围", options: ["项目", "风险"] }),
    fauxAssistantMessage(fauxText("不应续办")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "stop-waiting" });
  await waitFor(
    () => container!.autoloop.listInteractions().some((card) => card.state === "open"),
    "出现问题",
  );
  const card = container!.autoloop.listInteractions().find((item) => item.state === "open")!;
  await container!.autoloop.cancelTask(card.taskId!);
  await waitFor(
    () => container!.autoloop.listInteractions().every((item) => item.state !== "open"),
    "关闭旧卡片",
  );
  expect((await container!.tasks.get(card.taskId!))?.automationStatus).toBe("cancelled");
  expect(container!.autoloop.getBinding(binding.id)?.enabled).toBe(false);
  await expect(
    container!.autoloop.answerInteraction(card.id, {
      cardVersion: card.version,
      answerId: "late-answer",
      choice: 0,
    }),
  ).rejects.toThrow();
  await expect(container!.autoloop.resumeTask(card.taskId!)).rejects.toThrow(/已停止/);
  expect(faux!.state.callCount).toBe(1);
  expect(await container!.tasks.listRuns(card.taskId!)).toHaveLength(1);
}, 40000);
it("SQLite：旧宿主 epoch、过期 revision 和停止后的检查点都不能覆盖新状态", () => {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-autoloop-cas-"));
  roots.push(root);
  const first = openDatabase(root);
  const second = openDatabase(root);
  try {
    const oldHost = new AutoloopStore(first.db);
    const newHost = new AutoloopStore(second.db);
    oldHost.acquireEpoch();
    const checkpoint: DurableCheckpoint = {
      schemaVersion: 1,
      executorVersion: DURABLE_EXECUTOR_VERSION,
      revision: 1,
      agent: "orchestrator",
      phase: "model",
      turn: 0,
      messages: [],
      toolCalls: [],
      pendingCalls: [],
      nextToolIndex: 0,
      steps: {},
      allowedTools: null,
      text: "",
      providerId: null,
    };
    oldHost.saveCheckpoint("task", checkpoint);
    newHost.acquireEpoch();
    expect(() => oldHost.saveCheckpoint("task", { ...checkpoint, revision: 2 })).toThrow(
      /宿主已更新/,
    );
    newHost.saveCheckpoint("task", { ...checkpoint, revision: 2, text: "新宿主结果" });
    expect(() =>
      newHost.saveCheckpoint("task", { ...checkpoint, revision: 2, text: "过期结果" }),
    ).toThrow(/检查点已更新/);
    newHost.stopTask("task");
    expect(() => newHost.saveCheckpoint("task", { ...checkpoint, revision: 3 })).toThrow(/已停止/);
    expect(newHost.checkpoints.get("task")?.checkpoint).toMatchObject({
      revision: 2,
      text: "新宿主结果",
    });
  } finally {
    second.close();
    first.close();
  }
});
