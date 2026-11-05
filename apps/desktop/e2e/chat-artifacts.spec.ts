import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStreamEvent, Artifact } from "@agentdesk/shared";
import { createPresentation } from "../../sidecar/src/services/presentations";
import { artifactContent } from "../../sidecar/src/services/artifact-files";
import { registerDocumentTools } from "../../sidecar/src/agents/document-tools";
import { ToolRegistry, type ToolContext } from "../../../packages/agent-core/src/index";

/** 可控 SSE 用于验证每批到达前后的界面，并重放刷新前已接收的事件。 */
async function controlTaskStream(page: Page, taskId: string, runId: string) {
  await page.addInitScript(
    ({ taskId }) => {
      const key = `test-stream:${taskId}`;
      const records: unknown[] = JSON.parse(sessionStorage.getItem(key) ?? "[]");
      const listeners = new Set<(record: unknown) => void>();
      window.addEventListener("test-task-event", (event) => {
        const record = (event as CustomEvent).detail;
        records.push(record);
        sessionStorage.setItem(key, JSON.stringify(records));
        listeners.forEach((listener) => listener(record));
      });
      window.EventSource = new Proxy(window.EventSource, {
        construct(target, args) {
          if (!String(args[0]).includes(`/tasks/${taskId}/stream`))
            return Reflect.construct(target, args);
          const source = {
            onmessage: null as ((event: MessageEvent) => void) | null,
            onerror: null,
            close: () => listeners.delete(receive),
          };
          const receive = (record: unknown) =>
            source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(record) }));
          listeners.add(receive);
          queueMicrotask(() => records.forEach(receive));
          return source;
        },
      });
    },
    { taskId },
  );
  let seq = 0;
  return (event: AgentStreamEvent) =>
    page.evaluate(
      (record) => {
        window.dispatchEvent(new CustomEvent("test-task-event", { detail: record }));
      },
      { seq: ++seq, taskId, runId, parentRunId: null, event },
    );
}

test("产物事件打开右侧逐页预览，刷新仍可查看且下载真实 PPT", async ({ page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-ppt-ui-"));
  const artifacts: Artifact[] = [];
  await createPresentation(
    root,
    {
      title: "研发团队季度计划",
      slides: [
        {
          title: "研发团队季度计划",
          subtitle: "聚焦交付质量与研发效率",
          bullets: ["建立可衡量的交付目标", "以小范围试点验证改进方向"],
        },
        {
          title: "分阶段推进",
          bullets: ["第一阶段：明确基线", "第二阶段：实施试点", "第三阶段：复盘与推广"],
        },
      ],
    },
    {
      agent: "orchestrator",
      emit: () => {},
      requestApproval: async () => false,
      recordArtifact: (input) => {
        const artifact: Artifact = {
          ...input,
          id: `artifact-${artifacts.length}`,
          taskId: "ppt-task",
          runId: "ppt-run",
          version: 1,
          content: input.content ?? null,
          filePath: input.filePath ?? null,
          mimeType: input.mimeType ?? null,
          metadata: input.metadata ?? null,
          createdAt: new Date().toISOString(),
        };
        artifacts.push(artifact);
        return artifact;
      },
    },
  );
  let ready = false;
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/ppt-chat/workbench"),
    (route) =>
      route.fulfill({
        json: {
          conversation: { id: "ppt-chat", title: "制作季度计划演示文稿" },
          task: {
            id: "ppt-task",
            currentRunId: "ppt-run",
            purpose: "general",
            pendingApprovalId: null,
          },
          activity: ready ? null : "running",
          runs: [],
          artifacts: ready ? artifacts : [],
          usedTools: ["presentations.create"],
          pendingApprovalIds: [],
          pendingApprovals: 0,
          context: null,
          latestUsage: null,
          lastCompaction: null,
          contextError: null,
          workspace: null,
        },
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/ppt-chat/messages"),
    (route) =>
      route.fulfill({
        json: [
          {
            id: "old",
            role: "assistant",
            content:
              '出错了：This operation was aborted\n\n本轮已记录的操作：agents.delegate({"task":"private prompt"})',
            agent: null,
            toolCalls: [],
          },
          { id: "user", role: "user", content: "继续制作季度计划 PPT" },
        ],
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/tasks/ppt-task/stream"),
    (route) => {
      ready = true;
      return route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ seq: 1, taskId: "ppt-task", runId: "ppt-run", parentRunId: null, event: { type: "artifact_ready", artifactId: "artifact-1", title: "季度计划.pptx" } })}\n\n`,
      });
    },
  );
  await page.route(/\/api\/tasks\/ppt-task\/artifacts\/[^/]+\/content/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const artifact = artifacts.find((item) => item.id === id)!;
    await route.fulfill({ json: await artifactContent(artifact, root) });
  });
  await page.route(/\/api\/tasks\/ppt-task\/artifacts\/artifact-1\/download/, async (route) =>
    route.fulfill({
      body: await readFile(join(root, artifacts[1]!.filePath!)),
      contentType: artifacts[1]!.mimeType!,
      headers: { "Content-Disposition": "attachment; filename=quarterly-plan.pptx" },
    }),
  );
  await page.goto("/#/?c=ppt-chat");
  const panel = page.getByRole("complementary", { name: "成果预览" });
  await expect(panel).toBeVisible();
  await expect(page.getByText("agents.delegate", { exact: false })).toHaveCount(0);
  await expect(page.getByText("This operation was aborted", { exact: false })).toHaveCount(0);
  await expect(panel.getByText("第 1 / 2 页")).toBeVisible();
  const frame = panel.frameLocator('iframe[title="HTML 成果预览"]');
  await expect(frame.getByText("研发团队季度计划", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-ppt-desktop.png") });
  await panel.getByRole("button", { name: "下一页" }).click();
  await expect(frame.getByText("分阶段推进")).toBeVisible();
  await expect(panel.getByText("第 2 / 2 页", { exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await panel.getByRole("link", { name: "下载", exact: true }).click();
  const download = await downloadEvent;
  expect((await readFile((await download.path())!)).subarray(0, 2).toString()).toBe("PK");
  await page.reload();
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("chat-ppt-mobile.png") });
  await panel.getByRole("button", { name: "关闭成果预览" }).click();
  await expect(page.getByRole("region", { name: "本次成果" })).toBeVisible();
  await page.getByRole("region", { name: "本次成果" }).getByRole("button").click();
  await expect(panel).toBeVisible();
});

test("PPT 生成期间右侧逐页更新并可选回先前页面", async ({ page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-ppt-progress-"));
  const artifacts: Artifact[] = [];
  const events: AgentStreamEvent[] = [];
  await createPresentation(
    root,
    {
      title: "秋天的雨",
      theme: "warm",
      slides: [
        {
          title: "秋天的雨",
          subtitle: "三年级语文 · 课文赏析",
          bullets: ["读一读秋天的颜色", "听一听秋天的声音"],
        },
        { title: "走进课文", bullets: ["寻找课文里的比喻", "说说你眼中的秋天"] },
      ],
    },
    {
      agent: "orchestrator",
      emit: (event) => events.push(event),
      requestApproval: async () => false,
      recordArtifact: (input) => {
        const artifact: Artifact = {
          ...input,
          id: `artifact-${artifacts.length}`,
          taskId: "live-task",
          runId: "live-run",
          version: 1,
          content: input.content ?? null,
          filePath: input.filePath ?? null,
          mimeType: input.mimeType ?? null,
          metadata: input.metadata ?? null,
          createdAt: new Date().toISOString(),
        };
        artifacts.push(artifact);
        return artifact;
      },
    },
  );
  const emit = await controlTaskStream(page, "live-task", "live-run");
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/live-ppt/workbench"),
    (route) =>
      route.fulfill({
        json: {
          conversation: { id: "live-ppt", title: "秋天的雨课件" },
          task: {
            id: "live-task",
            currentRunId: "live-run",
            purpose: "general",
            pendingApprovalId: null,
          },
          activity: "running",
          runs: [],
          artifacts: [],
          usedTools: ["presentations.create"],
          pendingApprovalIds: [],
          pendingApprovals: 0,
          context: null,
          latestUsage: null,
          lastCompaction: null,
          contextError: null,
          workspace: null,
        },
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/live-ppt/messages"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.goto("/#/?c=live-ppt");
  await emit({ type: "agent_start", agent: "orchestrator" });
  await emit({ type: "response_start", agent: "orchestrator" });
  await expect(page.getByText("思考中…", { exact: true })).toBeVisible();
  await emit({
    type: "response_status",
    agent: "orchestrator",
    message: "响应中断，正在自动重试…",
  });
  await expect(page.getByText("响应中断，正在自动重试…", { exact: true })).toBeVisible();
  await emit({
    type: "text_delta",
    agent: "orchestrator",
    delta: "先制作课文导入页，再补充阅读练习。",
  });
  await expect(page.getByText("先制作课文导入页，再补充阅读练习。")).toBeVisible();
  await expect(page.getByText("思考中…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("响应中断，正在自动重试…", { exact: true })).toHaveCount(0);
  await emit({
    type: "tool_call",
    agent: "orchestrator",
    id: "start",
    name: "presentations.start",
    args: { private: "internal-data" },
  });
  const beginning = events.find(
    (event) => event.type === "presentation_status" && event.phase === "starting",
  )!;
  await emit(beginning);
  const panel = page.getByRole("complementary", { name: "生成中的演示文稿" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("正在准备第一页…")).toBeVisible();
  await panel.getByRole("button", { name: "关闭成果预览" }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: "查看成果" }).click();
  await expect(panel).toBeVisible();
  const slides = events.filter((event) => event.type === "presentation_slide");
  await emit(slides[0]!);
  await expect(panel.getByRole("button", { name: "第 1 页：秋天的雨" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "第 2 页：走进课文" })).toHaveCount(0);
  await page.reload();
  await expect(panel.getByText("第 1 / 1 页", { exact: true })).toBeVisible();
  await expect(page.getByText("先制作课文导入页，再补充阅读练习。")).toBeVisible();
  await emit(slides[1]!);
  await expect(panel.getByRole("button", { name: "第 2 页：走进课文" })).toBeVisible();
  await expect(panel.getByText("第 2 / 2 页", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-ppt-progress-desktop.png") });
  await panel.getByRole("button", { name: "第 1 页：秋天的雨" }).click();
  await expect(panel.getByText("第 1 / 2 页")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath("chat-ppt-progress-mobile.png") });
  await emit({
    type: "presentation_status",
    phase: "starting",
    presentationId: "second-deck",
    deckTitle: "课堂练习",
    message: "正在准备课堂练习",
  });
  await expect(panel.getByText("正在准备第一页…")).toBeVisible();
  await expect(panel.getByRole("button", { name: "第 2 页：走进课文" })).toHaveCount(0);
  await emit({
    ...slides[0]!,
    presentationId: "second-deck",
    deckTitle: "课堂练习",
    title: "复习目标",
    index: 1,
    total: 1,
  });
  await expect(panel.getByText("第 1 / 1 页", { exact: true })).toBeVisible();
  await expect(page.getByText("internal-data", { exact: false })).toHaveCount(0);
});

test("对话连接断开后通过任务事件恢复进展，不重复发送任务", async ({ page }) => {
  const emit = await controlTaskStream(page, "recover-task", "recover-run");
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!String(input).endsWith("/api/chat")) return fetch(input, init);
      sessionStorage.setItem(
        "test-chat-count",
        String(Number(sessionStorage.getItem("test-chat-count") ?? "0") + 1),
      );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          send({ type: "conversation", conversationId: "recover-chat" });
          send({ type: "agent_start", agent: "orchestrator" });
          send({ type: "text_delta", agent: "orchestrator", delta: "开始撰写第一章。" });
          window.addEventListener(
            "test-break-chat",
            () => controller.error(new TypeError("Failed to fetch")),
            { once: true },
          );
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  let active = false;
  let finished = false;
  let stopCalls = 0;
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/recover-chat/workbench"),
    (route) =>
      route.fulfill({
        json: {
          conversation: { id: "recover-chat", title: "恢复文档任务" },
          task: { id: "recover-task", currentRunId: "recover-run", purpose: "general" },
          activity: active ? "running" : null,
          runs: [],
          artifacts: [],
          usedTools: [],
          pendingApprovalIds: [],
          pendingApprovals: 0,
          context: null,
          latestUsage: null,
          lastCompaction: null,
          contextError: null,
          workspace: null,
        },
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/recover-chat/messages"),
    (route) =>
      route.fulfill({
        json: finished
          ? [
              {
                id: "completed",
                role: "assistant",
                agent: "orchestrator",
                content: "文档已完成。",
                toolCalls: [],
                display: [{ kind: "text", text: "文档已完成。" }],
              },
            ]
          : [],
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => /\/(stop|cancel)$/.test(url.pathname),
    (route) => {
      stopCalls++;
      return route.fulfill({ json: {} });
    },
  );
  await page.goto("/#/?c=recover-chat");
  await page.getByRole("textbox").last().fill("制作入职指南");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("开始撰写第一章。")).toBeVisible();
  active = true;
  await page.evaluate(() => window.dispatchEvent(new Event("test-break-chat")));
  await emit({ type: "agent_start", agent: "orchestrator" });
  await emit({ type: "text_delta", agent: "orchestrator", delta: "继续撰写第二章。" });
  await expect(page.getByText("继续撰写第二章。")).toBeVisible();
  await expect(page.getByText("Failed to fetch", { exact: false })).toHaveCount(0);
  expect(stopCalls).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("test-chat-count"))).toBe("1");
  finished = true;
  active = false;
  await emit({ type: "done", messageId: "completed" });
  await expect(page.getByText("文档已完成。", { exact: true })).toHaveCount(1);
  await expect(page.getByText("继续撰写第二章。")).toHaveCount(0);
});

test("文档生成中逐章预览，完成后下载 Word 并恢复阶段文本", async ({ page }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-doc-ui-"));
  const artifacts: Artifact[] = [];
  const registry = new ToolRegistry();
  registerDocumentTools(registry, root);
  const ctx: ToolContext = {
    agent: "orchestrator",
    emit: () => {},
    requestApproval: async () => false,
    recordArtifact: (input) => {
      const record: Artifact = {
        ...input,
        id: `doc-${artifacts.length}`,
        taskId: "doc-task",
        runId: "doc-run",
        version: artifacts.length + 1,
        content: input.content ?? null,
        filePath: input.filePath ?? null,
        mimeType: input.mimeType ?? null,
        metadata: input.metadata ?? null,
        createdAt: new Date().toISOString(),
      };
      artifacts.push(record);
      return record;
    },
  };
  const started = (await registry
    .get("documents.start")!
    .execute({ title: "新同事入职指南", total: 2 }, ctx)) as { draftId: string };
  await registry.get("documents.append")!.execute(
    {
      ...started,
      afterSection: 0,
      sections: [{ heading: "第一天", paragraphs: ["认识团队，开通办公账号。"] }],
    },
    ctx,
  );
  await registry.get("documents.append")!.execute(
    {
      ...started,
      afterSection: 1,
      sections: [{ heading: "第一周", paragraphs: ["与导师完成第一周复盘。"] }],
    },
    ctx,
  );
  await registry.get("documents.finish")!.execute(started, ctx);
  let complete = false;
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/doc-chat/workbench"),
    (route) =>
      route.fulfill({
        json: {
          conversation: { id: "doc-chat", title: "撰写入职指南" },
          task: {
            id: "doc-task",
            currentRunId: "doc-run",
            purpose: "general",
            pendingApprovalId: null,
          },
          activity: complete ? null : "running",
          runs: [],
          artifacts: complete ? artifacts : [],
          usedTools: [],
          pendingApprovalIds: [],
          pendingApprovals: 0,
          context: null,
          latestUsage: null,
          lastCompaction: null,
          contextError: null,
          workspace: null,
        },
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/conversations/doc-chat/messages"),
    (route) =>
      route.fulfill({
        json: complete
          ? [
              {
                id: "result",
                role: "assistant",
                agent: "orchestrator",
                content: "Word 文档已完成。",
                toolCalls: [],
                display: [
                  { kind: "text", text: "先准备入职第一天的内容。" },
                  {
                    kind: "activity",
                    id: "append",
                    agent: "orchestrator",
                    name: "documents.append",
                    status: "complete",
                  },
                  { kind: "text", text: "Word 文档已完成。" },
                ],
              },
            ]
          : [],
      }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/approvals"),
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(
    (url) => url.pathname.endsWith("/api/tasks/doc-task/stream"),
    (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ seq: 1, taskId: "doc-task", runId: "doc-run", parentRunId: null, event: { type: "document_preview", title: "新同事入职指南", content: artifacts[0]!.content, completed: 1, total: 2 } })}\n\n`,
      }),
  );
  await page.route(/\/api\/tasks\/doc-task\/artifacts\/[^/]+\/content/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    await route.fulfill({
      json: await artifactContent(
        artifacts.find((item) => item.id === id)!,
        root,
      ),
    });
  });
  await page.route(/\/api\/tasks\/doc-task\/artifacts\/doc-2\/download/, async (route) =>
    route.fulfill({
      body: await readFile(join(root, artifacts[2]!.filePath!)),
      contentType: artifacts[2]!.mimeType!,
      headers: { "Content-Disposition": "attachment; filename=onboarding.docx" },
    }),
  );
  await page.goto("/#/?c=doc-chat");
  const live = page.getByRole("complementary", { name: "生成中的文档" });
  await expect(live).toBeVisible();
  await expect(live.getByText("已写 1 / 2 章")).toBeVisible();
  await expect(live.getByText("认识团队，开通办公账号。")).toBeVisible();
  await expect(live.getByText("与导师完成第一周复盘。")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("chat-document-progress.png") });
  complete = true;
  const panel = page.getByRole("complementary", { name: "成果预览" });
  await expect(panel).toBeVisible({ timeout: 10000 });
  await expect(panel.getByText("与导师完成第一周复盘。")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await panel.getByRole("link", { name: "下载", exact: true }).click();
  const downloaded = await downloading;
  expect(
    (await readFile((await downloaded.path())!)).includes(Buffer.from("word/document.xml")),
  ).toBe(true);
  await page.reload();
  await expect(page.getByText("先准备入职第一天的内容。")).toBeVisible();
  await expect(page.getByText("Word 文档已完成。")).toBeVisible();
});
