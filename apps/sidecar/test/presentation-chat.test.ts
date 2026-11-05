import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName } from "@agentdesk/agent-core";
import { chatMessageContent, runFailureMessage } from "@agentdesk/shared";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { createApp } from "../src/http/app";
import { createPresentation } from "../src/services/presentations";

let container: Container;
let faux: FauxProviderRegistration;
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agentdesk-presentation-"));
  container = await createContainer(loadConfig({ AGENTDESK_DATA_DIR: root }), { inMemory: true });
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "x" },
  ];
});
afterAll(async () => {
  await container.dispose();
  faux.unregister();
});
const request = (path: string, body?: unknown) =>
  createApp(container).request(`/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待任务超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("聊天断开后问题仍可回答，继续生成真实 PPT、预览和可下载成果", async () => {
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(toWireName("tasks.ask_user"), {
        question: "选择演示风格",
        options: ["商务蓝", "深色"],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(toWireName("presentations.create"), {
        title: "团队季度计划",
        theme: "blue",
        slides: [
          {
            title: "季度计划",
            subtitle: "研发团队",
            bullets: ["提升交付质量", "以下指标为示例"],
            notes: "请替换为真实数据",
          },
          { title: "执行路线", bullets: ["第一月梳理流程", "第二月试点验证", "第三月复盘推广"] },
        ],
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxText("演示文稿已生成，可以在右侧预览。")),
    fauxAssistantMessage(fauxText('{"memories":[]}')),
  ]);
  const response = await request("/chat", { message: "制作团队季度计划 PPT" });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const conversationId = JSON.parse(first.split("data: ")[1]!.trim()).conversationId as string;
  await waitFor(() => container.approvals.list("pending").some((a) => a.kind === "question"));
  const question = container.approvals.list("pending").find((a) => a.kind === "question")!;
  await reader.cancel();
  const task = container.tasks.findByConversation(conversationId)!;
  expect(container.tasks.getRun(task.currentRunId!)?.status).toBe("running");
  expect((await request(`/approvals/${question.id}/answer`, { text: "商务蓝" })).status).toBe(200);
  await waitFor(() => container.tasks.getRun(task.currentRunId!)?.status === "succeeded");
  expect(container.approvals.list().filter((a) => a.kind === "tool")).toHaveLength(0);
  const artifacts = container.tasks.listArtifacts(task.id);
  const file = artifacts.find((item) => item.title.endsWith(".pptx"))!;
  expect(file).toBeDefined();
  const previewId = (file.metadata as { previewArtifactId: string }).previewArtifactId;
  const preview = await container.tasks.readArtifact(task.id, previewId);
  expect(preview.content).toContain('data-slide="2"');
  expect(preview.content).toContain("执行路线");
  const download = await request(`/tasks/${task.id}/artifacts/${file.id}/download`);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toContain("presentationml.presentation");
  const bytes = Buffer.from(await download.arrayBuffer());
  expect(bytes.subarray(0, 2).toString()).toBe("PK");
  expect(bytes.includes(Buffer.from("ppt/slides/slide2.xml"))).toBe(true);
  expect(
    container.tasks
      .eventsAfter({ runId: task.currentRunId!, after: 0, limit: 500 })
      .some(
        (record) => record.event.type === "artifact_ready" && record.event.artifactId === file.id,
      ),
  ).toBe(true);
  const events = container.tasks.eventsAfter({ runId: task.currentRunId!, after: 0, limit: 500 });
  const slides = events.filter((record) => record.event.type === "presentation_slide");
  expect(slides).toHaveLength(2);
  expect(
    slides.map((record) => (record.event.type === "presentation_slide" ? record.event.index : 0)),
  ).toEqual([1, 2]);
  expect(
    events.findIndex(
      (record) => record.event.type === "presentation_slide" && record.event.index === 1,
    ),
  ).toBeLessThan(
    events.findIndex(
      (record) => record.event.type === "artifact_ready" && record.event.artifactId === file.id,
    ),
  );
  expect(container.chat.messages(conversationId).at(-1)?.content).toContain("右侧预览");
  const persisted = container.chat.messages(conversationId).at(-1)!;
  expect(
    persisted.display?.some((block) => block.kind === "text" && block.text.includes("右侧预览")),
  ).toBe(true);
  expect(JSON.stringify(persisted.display)).not.toContain('"args"');
});

it("明确停止会取消运行，但不会把工具参数写进失败消息", async () => {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(toWireName("tasks.ask_user"), { question: "需要几页？" }), {
      stopReason: "toolUse",
    }),
  ]);
  const response = await request("/chat", { message: "先规划 PPT" });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const conversationId = JSON.parse(first.split("data: ")[1]!.trim()).conversationId as string;
  await waitFor(() => container.approvals.list("pending").some((a) => a.kind === "question"));
  expect((await request(`/conversations/${conversationId}/stop`, {})).status).toBe(204);
  const task = container.tasks.findByConversation(conversationId)!;
  await waitFor(() => container.tasks.getRun(task.currentRunId!)?.status === "cancelled");
  const message = container.chat.messages(conversationId).at(-1)!;
  expect(message.content).toContain("任务已停止");
  expect(message.content).not.toContain("tasks.ask_user");
  expect(message.toolCalls).not.toHaveLength(0);
  await reader.cancel();
});

it("旧中断记录只显示用户提示，普通正文与代码示例保持完整", () => {
  const legacy =
    '出错了：This operation was aborted\n\n本轮已记录的操作（续跑时跳过已确认完成的操作）：agents.delegate({"task":"secret"})';
  expect(chatMessageContent(legacy)).toBe(runFailureMessage("aborted"));
  expect(chatMessageContent("下面是示例：`agents.delegate()`")).toContain("agents.delegate");
  expect(runFailureMessage("Bearer private-token stack trace")).not.toContain("private-token");
});

it("生成前校验页数与内容上限，取消后不发布成果", async () => {
  const controller = new AbortController();
  controller.abort();
  let recorded = false;
  const ctx = {
    agent: "orchestrator" as const,
    signal: controller.signal,
    emit: () => {},
    requestApproval: async () => false,
    recordArtifact: () => {
      recorded = true;
      return { id: "unexpected", version: 1 };
    },
  };
  await expect(createPresentation(root, { title: "测试", slides: [] }, ctx)).rejects.toThrow();
  await expect(
    createPresentation(root, { title: "测试", slides: [{ title: "第一页" }] }, ctx),
  ).rejects.toThrow();
  expect(recorded).toBe(false);
});
