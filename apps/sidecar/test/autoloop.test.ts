import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { AutoloopStore } from "../src/services/autoloop/store";
import { createApp } from "../src/http/app";

let container: Container | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(async () => {
  await container?.dispose();
  container = undefined;
  faux?.unregister();
  faux = undefined;
  vi.restoreAllMocks();
});
async function waitFor(predicate: () => boolean, description: string) {
  const end = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > end)
      throw new Error(`等待超时：${description}; ${JSON.stringify(container?.tasks.list())}`);
    await container?.autoloop.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
async function setup(fetchImpl?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-autoloop-"));
  const workspace = join(root, "项目 空格");
  mkdirSync(workspace);
  execFileSync("git", ["init", workspace], { stdio: "ignore" });
  const config = loadConfig({ AGENTDESK_DATA_DIR: join(root, "data") });
  container = await createContainer(config, { autoloopFetch: fetchImpl });
  faux = registerFauxProvider({ tokensPerSecond: 100000 });
  const connect = () => {
    container!.providers.resolve = async () => [
      { providerId: "faux", providerName: "faux", model: faux!.getModel(), apiKey: "test" },
    ];
  };
  connect();
  const project = await container.projects.add(workspace);
  const binding = await container.autoloop.createBinding({
    title: "项目周报",
    goal: "写入进展后询问重点，回答后生成演示文稿",
    projectId: project.id,
    workspacePolicy: { root: workspace, allowSubdirectories: false },
    maxRounds: 20,
    maxMinutes: 5,
  });
  return { root, workspace, config, connect, project, binding };
}
const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage(fauxToolCall(toWireName(name), args), { stopReason: "toolUse" });

it("真实 Hub：写文件后等待释放额度，重启回答续办同一 Task，已完成写入不重跑", async () => {
  const { workspace, config, connect, project, binding } = await setup();
  container!.permissionRules.add("fs.write", "progress.txt");
  const write = vi.spyOn(
    container!.registry.list().find((t) => t.name === "fs.write")!,
    "execute",
  );
  faux!.setResponses([
    tool("fs.write", { project: project.id, path: "progress.txt", content: "已完成首阶段" }),
    tool("tasks.ask_user", { question: "汇报重点？", options: ["项目进展", "风险计划"] }),
    tool("presentations.create", {
      title: "项目周报",
      theme: "blue",
      slides: [{ title: "项目进展", bullets: ["已完成首阶段"] }],
    }),
    fauxAssistantMessage(fauxText("周报已生成。")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "first" });
  await waitFor(
    () => container!.autoloop.listInteractions().some((c) => c.state === "open"),
    "出现持久问题",
  );
  const task = container!.autoloop.listTasks(binding.id)[0]!;
  expect(container!.tasks.get(task.id)?.automationStatus).toBe("waiting_input");
  expect(write).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(workspace, "progress.txt"), "utf8")).toBe("已完成首阶段");
  const slot = container!.tasks.reserveExternalSlot();
  expect(slot).toBeTypeOf("function");
  slot?.();
  expect(() => container!.tasks.enqueue(task.currentRunId!)).toThrow(/托管/);
  const ordinaryChat = await createApp(container!).request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: task.conversationId, message: "绕过后台执行" }),
  });
  expect(ordinaryChat.status).toBe(409);
  await container!.dispose();
  container = await createContainer(config);
  connect();
  const writeAfter = vi.spyOn(
    container.registry.list().find((t) => t.name === "fs.write")!,
    "execute",
  );
  const card = container.autoloop.listInteractions(task.id).find((c) => c.state === "open")!;
  expect(card.description).toBe("汇报重点？");
  await container.autoloop.answerInteraction(card.id, {
    cardVersion: card.version,
    answerId: "answer-one",
    choice: 0,
  });
  await waitFor(
    () => container!.tasks.get(task.id)?.automationStatus === "completed",
    "回答后完成",
  );
  expect(writeAfter).not.toHaveBeenCalled();
  expect(container.tasks.listRuns(task.id)).toHaveLength(2);
  expect(container.tasks.listArtifacts(task.id).some((a) => a.title.endsWith(".pptx"))).toBe(true);
  expect(container.autoloop.listInteractions(task.id).filter((c) => c.kind === "ask")).toHaveLength(
    1,
  );
  expect(container.chat.messages(task.conversationId)[0]?.role).toBe("user");
}, 60000);

it("真实 Hub：模型临时故障通过持久回执退避，等待期间不重新调用模型", async () => {
  const { binding } = await setup();
  faux!.setResponses(
    Array.from({ length: 3 }, () =>
      fauxAssistantMessage(fauxText(""), {
        stopReason: "error",
        errorMessage: "503 temporarily unavailable",
      }),
    ),
  );
  const models = vi.spyOn(container!.providers, "resolve");
  await container!.autoloop.trigger(binding.id, { eventId: "retry" });
  await waitFor(
    () => container!.autoloop.listTasks(binding.id)[0]?.automationStatus === "retry_scheduled",
    "退避等待",
  );
  const task = container!.autoloop.listTasks(binding.id)[0]!;
  const count = models.mock.calls.length;
  await container!.autoloop.tick();
  await container!.autoloop.tick();
  expect(models.mock.calls.length).toBe(count);
  expect(container!.tasks.getRun(task.currentRunId!)?.status).toBe("failed");
  const store = new AutoloopStore(container!.dbHandle.db);
  expect(store.checkpoints.get(task.id)?.checkpoint.phase).toBe("model");
  expect(store.outbox.list().find((c) => c.operation === "result")?.status).toBe("delivered");
  await container!.autoloop.cancelTask(task.id);
  expect(container!.tasks.get(task.id)?.automationStatus).toBe("cancelled");
}, 60000);

it("真实 Hub：事件、回答和回执在服务端成功后丢失响应，只重放原文", async () => {
  const lost = new Set<string>();
  const bodies = new Map<string, string[]>();
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(input, init);
    if (init?.method === "POST" && /\/events$|\/answer$|\/result$/.test(url.pathname)) {
      const key = url.pathname;
      const body = String(init.body);
      bodies.set(key, [...(bodies.get(key) ?? []), body]);
      if (response.ok && !lost.has(key)) {
        lost.add(key);
        await response.body?.cancel();
        throw new TypeError("模拟响应丢失");
      }
    }
    return response;
  };
  const { binding } = await setup(transport);
  faux!.setResponses([
    tool("tasks.ask_user", { question: "确认重点？", options: ["进展", "风险"] }),
    fauxAssistantMessage(fauxText("已按选择完成。")),
  ]);
  await expect(container!.autoloop.trigger(binding.id, { eventId: "lost-event" })).rejects.toThrow(
    /保留记录/,
  );
  await waitFor(
    () => container!.autoloop.listInteractions().some((c) => c.state === "open"),
    "丢失回执仍出现问题",
  );
  const card = container!.autoloop.listInteractions().find((c) => c.state === "open")!;
  await expect(
    container!.autoloop.answerInteraction(card.id, {
      cardVersion: card.version,
      answerId: "lost-answer",
      choice: 1,
    }),
  ).rejects.toThrow(/保留记录/);
  await waitFor(
    () => container!.tasks.get(card.taskId!)?.automationStatus === "completed",
    "重试回答和最终回执",
  );
  expect(container!.autoloop.listTasks(binding.id)).toHaveLength(1);
  for (const attempts of bodies.values()) {
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(attempts).size).toBe(1);
  }
  const store = new AutoloopStore(container!.dbHandle.db);
  expect(store.outbox.list().every((c) => c.status === "delivered")).toBe(true);
}, 60000);

it("真实 Hub：完成后在同一事项追加修改，重复请求只创建一个新 Run", async () => {
  const { binding } = await setup();
  faux!.setResponses([
    fauxAssistantMessage(fauxText("第一版完成。")),
    fauxAssistantMessage(fauxText("补充版完成。")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "initial" });
  await waitFor(
    () => container!.autoloop.listTasks(binding.id)[0]?.automationStatus === "completed",
    "完成第一版",
  );
  const task = container!.autoloop.listTasks(binding.id)[0]!;
  await container!.autoloop.followupTask(task.id, { message: "补充风险", eventId: "followup" });
  await container!.autoloop.followupTask(task.id, { message: "补充风险", eventId: "followup" });
  await waitFor(
    () =>
      container!.tasks.listRuns(task.id).length === 2 &&
      container!.tasks.get(task.id)?.automationStatus === "completed",
    "完成修改",
  );
  expect(
    container!.chat
      .messages(task.conversationId)
      .filter((m) => m.role === "user")
      .map((m) => m.content),
  ).toContain("补充风险");
  expect(container!.autoloop.listTasks(binding.id)).toHaveLength(1);
}, 60000);

it("真实 Hub：等待时间时释放执行额度，时间到后续办同一事项", async () => {
  const { binding } = await setup();
  faux!.setResponses([
    tool("tasks.wait_until", {
      at: new Date(Date.now() + 2200).toISOString(),
      about: "稍后复核进度",
    }),
    fauxAssistantMessage(fauxText("已完成复核。")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "timer" });
  await waitFor(
    () => container!.autoloop.listTasks(binding.id)[0]?.automationStatus === "waiting_timer",
    "定时等待",
  );
  const task = container!.autoloop.listTasks(binding.id)[0]!;
  const slot = container!.tasks.reserveExternalSlot();
  expect(slot).toBeTypeOf("function");
  slot?.();
  await waitFor(
    () => container!.tasks.get(task.id)?.automationStatus === "completed",
    "时间到后续办",
  );
  expect(container!.tasks.listRuns(task.id)).toHaveLength(2);
}, 60000);

it("真实 Hub：停用后续触发仍可回答；停止整个事项关闭卡片且不再执行", async () => {
  const { binding } = await setup();
  faux!.setResponses([
    tool("tasks.ask_user", { question: "确认第一项？", options: ["是", "否"] }),
    tool("tasks.ask_user", { question: "确认第二项？", options: ["是", "否"] }),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "disable" });
  await waitFor(
    () => container!.autoloop.listInteractions().some((c) => c.state === "open"),
    "第一个问题",
  );
  const card = container!.autoloop.listInteractions().find((c) => c.state === "open")!;
  await container!.autoloop.disableBinding(binding.id);
  await container!.autoloop.answerInteraction(card.id, {
    cardVersion: card.version,
    choice: 0,
    answerId: "after-disable",
  });
  await waitFor(
    () =>
      container!.autoloop
        .listInteractions()
        .some((c) => c.description === "确认第二项？" && c.state === "open"),
    "停用后可继续回答",
  );
  await container!.autoloop.cancelTask(card.taskId!);
  await waitFor(
    () => container!.autoloop.listInteractions().every((c) => c.state !== "open"),
    "停止后关闭问题",
  );
  expect(container!.tasks.get(card.taskId!)?.automationStatus).toBe("cancelled");
  await expect(container!.autoloop.trigger(binding.id, { eventId: "after-stop" })).rejects.toThrow(
    /停用/,
  );
}, 60000);

it("真实 Hub：旧业务回答不能在重启后批准新出现的文件授权", async () => {
  let rejectResult = false;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (rejectResult && /\/result$/.test(url.pathname)) throw new TypeError("回执未发送");
    return fetch(input, init);
  };
  const { binding, project, workspace, config, connect } = await setup(transport);
  faux!.setResponses([
    tool("tasks.ask_user", { question: "选择报告类型", options: ["进展", "风险"] }),
    tool("fs.write", { project: project.id, path: "authorization.txt", content: "必须单独授权" }),
    fauxAssistantMessage(fauxText("写入完成。")),
  ]);
  await container!.autoloop.trigger(binding.id, { eventId: "approval-boundary" });
  await waitFor(
    () => container!.autoloop.listInteractions().some((c) => c.state === "open"),
    "业务问题",
  );
  const card = container!.autoloop.listInteractions().find((c) => c.state === "open")!;
  rejectResult = true;
  await container!.autoloop.answerInteraction(card.id, {
    answerId: "business-yes",
    cardVersion: card.version,
    choice: 0,
  });
  const store = new AutoloopStore(container!.dbHandle.db);
  await waitFor(
    () => store.checkpoints.get(card.taskId!)?.checkpoint.suspension?.kind === "authorization",
    "保存新授权检查点",
  );
  await container!.dispose();
  // 模拟进程在检查点落库后、回执 outbox 落库前终止。
  const { openDatabase } = await import("../src/db/client");
  const handle = openDatabase(config.dataDir);
  const recovery = new AutoloopStore(handle.db);
  const latest = recovery.links
    .list()
    .find((l) => l.taskId === card.taskId && l.state === "running")!;
  for (const entry of recovery.outbox
    .list()
    .filter((e) => e.linkId === latest.id && e.operation === "result"))
    recovery.outbox.delete(entry.id);
  handle.close();
  rejectResult = false;
  container = await createContainer(config);
  connect();
  await waitFor(
    () =>
      container!.autoloop
        .listInteractions()
        .some((c) => c.state === "open" && c.interactionKind === "authorization"),
    "恢复后仍等待独立授权",
  );
  expect(existsSync(join(workspace, "authorization.txt"))).toBe(false);
  const approval = container!.autoloop
    .listInteractions()
    .find((c) => c.state === "open" && c.interactionKind === "authorization")!;
  await container!.autoloop.answerInteraction(approval.id, {
    answerId: "file-yes",
    cardVersion: approval.version,
    choice: 0,
  });
  await waitFor(
    () => container!.tasks.get(card.taskId!)?.automationStatus === "completed",
    "文件授权后继续",
  );
  expect(readFileSync(join(workspace, "authorization.txt"), "utf8")).toBe("必须单独授权");
}, 60000);

it("真实 Hub：未知用量按未知处理，Token 预算阻止未执行写入", async () => {
  const { binding, project, workspace } = await setup();
  const budgeted = await container!.autoloop.createBinding({
    title: "受限预算",
    goal: binding.goal,
    projectId: project.id,
    workspacePolicy: binding.workspacePolicy,
    maxRounds: 20,
    maxMinutes: 5,
    maxTokens: 1,
  });
  container!.permissionRules.add("fs.write", "budget.txt");
  faux!.setResponses([
    tool("fs.write", { project: project.id, path: "budget.txt", content: "不应执行" }),
    fauxAssistantMessage(fauxText("完成")),
  ]);
  await container!.autoloop.trigger(budgeted.id, { eventId: "budget" });
  await waitFor(
    () => container!.autoloop.listTasks(budgeted.id)[0]?.automationStatus === "needs_attention",
    "预算停止",
  );
  expect(existsSync(join(workspace, "budget.txt"))).toBe(false);
  const task = container!.autoloop.listTasks(budgeted.id)[0]!;
  expect(container!.tasks.getRun(task.currentRunId!)?.resultError).toMatch(/用量|预算/);
}, 60000);
