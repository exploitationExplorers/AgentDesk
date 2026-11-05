import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ToolRegistry, type ToolContext } from "@agentdesk/agent-core";
import { emptyChatProgress, reduceChatProgress, type AgentStreamEvent } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { TaskService } from "../src/services/tasks";
import { EventHub } from "../src/events";
import { PresentationDrafts } from "../src/services/presentation-drafts";
import { registerDocumentTools } from "../src/agents/document-tools";

let db: DbHandle;
afterEach(() => db?.close());
function setup() {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-drafts-"));
  db = openDatabase(":memory:");
  const tasks = new TaskService(db.db, new EventHub(), { artifactRoot: root });
  const task = tasks.create({
    goal: "生成文稿",
    conversationId: "drafts",
    requiresPlanApproval: false,
  });
  const run = tasks.createRun({
    taskId: task.id,
    kind: "root",
    trigger: "create",
    agent: "orchestrator",
    input: { userMessage: task.goal },
  });
  const events: AgentStreamEvent[] = [];
  const controller = new AbortController();
  const ctx: ToolContext = {
    agent: "orchestrator",
    signal: controller.signal,
    emit: (event) => events.push(event),
    requestApproval: async () => {
      throw new Error("不应弹出审批");
    },
    recordArtifact: (input) => tasks.recordArtifact({ ...input, taskId: task.id, runId: run.id }),
  };
  return { root, tasks, task, run, events, ctx, controller };
}

it("PPT 按批次发布页面，拒绝重复追加和跨会话草稿引用，完成后可读取文件", async () => {
  const { root, tasks, task, events, ctx } = setup();
  const drafts = new PresentationDrafts(root);
  const draft = drafts.start({ title: "安全试点", total: 2 }, ctx);
  const first = await drafts.append(
    { draftId: draft.draftId, afterSlide: 0, slides: [{ title: "目标", bullets: ["第一阶段"] }] },
    ctx,
  );
  expect((await tasks.readArtifact(task.id, first.artifactId)).content).toContain("第一阶段");
  expect(events.filter((event) => event.type === "presentation_slide")).toHaveLength(1);
  await expect(drafts.finish(draft.draftId, ctx)).rejects.toThrow("补齐");
  await expect(
    drafts.append({ draftId: draft.draftId, afterSlide: 0, slides: [{ title: "重复" }] }, ctx),
  ).rejects.toThrow("勿重复");
  await expect(
    drafts.append(
      { draftId: draft.draftId, afterSlide: 1, slides: [{ title: "跨会话" }] },
      { ...ctx, recordArtifact: (input) => ctx.recordArtifact!(input) },
    ),
  ).rejects.toThrow("没有该草稿");
  await drafts.append(
    { draftId: draft.draftId, afterSlide: 1, slides: [{ title: "验收", bullets: ["第二阶段"] }] },
    ctx,
  );
  const result = await drafts.finish(draft.draftId, ctx);
  const content = await tasks.readArtifact(task.id, result.artifactId);
  expect(content.encoding).toBe("base64");
  expect(
    Buffer.from(content.content, "base64").includes(Buffer.from("ppt/slides/slide2.xml")),
  ).toBe(true);
  expect(content.artifact.version).toBe(3);
});

it("文档分章节预览且导出真实 Word，停止后保留已经写好的内容", async () => {
  const { root, tasks, task, events, ctx, controller } = setup();
  const registry = new ToolRegistry();
  registerDocumentTools(registry, root);
  const call = (name: string, input: unknown) => registry.get(name)!.execute(input, ctx);
  const start = (await call("documents.start", { title: "入职指南", total: 2 })) as {
    draftId: string;
  };
  await call("documents.append", {
    ...start,
    afterSection: 0,
    sections: [{ heading: "准备", paragraphs: ["开通工作账号。"] }],
  });
  expect(
    events.some(
      (event) =>
        event.type === "document_preview" &&
        event.completed === 1 &&
        event.content.includes("开通工作账号"),
    ),
  ).toBe(true);
  await expect(call("documents.finish", start)).rejects.toThrow("尚未完成");
  await call("documents.append", {
    ...start,
    afterSection: 1,
    sections: [{ heading: "复盘", paragraphs: ["第一周结束与导师复盘。"] }],
  });
  const finished = (await call("documents.finish", start)) as { artifactId: string };
  const file = await tasks.readArtifact(task.id, finished.artifactId);
  expect(file.mimeType).toContain("wordprocessingml");
  expect(Buffer.from(file.content, "base64").includes(Buffer.from("word/document.xml"))).toBe(true);
  const previewId = (file.artifact.metadata as { previewArtifactId: string }).previewArtifactId;
  expect((await tasks.readArtifact(task.id, previewId)).content).toContain("导师复盘");
  controller.abort();
  await expect(call("documents.start", { title: "停止后", total: 1 })).rejects.toThrow();
  expect((await tasks.readArtifact(task.id, previewId)).content).toContain("开通工作账号");
});

it("公开阶段按事件排序，只有等待模型时显示思考，展示记录没有内部工具参数", () => {
  const events: AgentStreamEvent[] = [
    { type: "agent_start", agent: "orchestrator" },
    { type: "response_start", agent: "orchestrator" },
    { type: "text_delta", agent: "orchestrator", delta: "先确认教学目标。" },
    {
      type: "tool_call",
      agent: "orchestrator",
      id: "q",
      name: "tasks.ask_user",
      args: { token: "private" },
    },
    { type: "approval_required", approvalId: "q", title: "问题", detail: "raw-internal" },
  ];
  let state = events.reduce(reduceChatProgress, emptyChatProgress());
  expect(state.phase).toBe("waiting");
  state = reduceChatProgress(state, {
    type: "tool_result",
    agent: "orchestrator",
    id: "q",
    result: "三年级",
    isError: false,
  });
  expect(state.phase).toBe("thinking");
  state = reduceChatProgress(state, {
    type: "text_delta",
    agent: "orchestrator",
    delta: "开始制作课件。",
  });
  expect(state.phase).toBe("writing");
  expect(state.blocks.map((block) => block.kind)).toEqual(["text", "activity", "text"]);
  expect(JSON.stringify(state.blocks)).not.toMatch(/private|raw-internal/);
});
