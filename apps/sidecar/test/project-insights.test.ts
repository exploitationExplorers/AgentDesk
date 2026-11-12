import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import type { Project, ProjectInsight, Task } from "@agentdesk/shared";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { createApp } from "../src/http/app";
import { Collection } from "../src/db/collection";
import { ProjectInsightService } from "../src/services/project-insights";
import {
  isPublicAddress,
  publicSourceUrl,
  readPublicArticle,
} from "../src/services/insight-source";
let container: Container;
let project: Project;
let faux: FauxProviderRegistration;
const sourceText =
  "文章提出：保留任务目标、约束与未完成事项。会话可以分组、归档和置顶，成果应当支持独立预览与版本记录。";
const result = (path = "README.md", quote = "保留任务目标、约束与未完成事项") => ({
  summary: "对照已检查的文件，建议改进会话摘要。",
  suggestions: [
    {
      title: "增加持久化会话摘要",
      status: "partial",
      priority: "high",
      effort: "medium",
      rationale: "README 只描述聊天",
      proposal: "增加摘要面板",
      sourceQuote: quote,
      evidence: [{ path, detail: "项目介绍仅描述聊天功能，具体能力待进一步核实" }],
      acceptance: ["重启后可以查看摘要"],
    },
  ],
});
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-insights-project-"));
  execFileSync("git", ["init", root], { windowsHide: true, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# 项目\n提供聊天功能\n");
  writeFileSync(join(root, ".env"), "DO_NOT_SEND_SECRET=private-value");
  container = await createContainer(
    {
      ...loadConfig({ AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-insights-")) }),
      token: "test",
    },
    { inMemory: true },
  );
  project = await container.projects.add(root);
  faux = registerFauxProvider({ tokensPerSecond: 100000 });
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux.getModel(), apiKey: "test" },
  ];
});
afterAll(async () => {
  await container.dispose();
  faux.unregister();
});
const request = (path: string, body?: unknown) =>
  createApp(container).request(`/api${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "test" },
    body: body ? JSON.stringify(body) : undefined,
  });
async function analyze(payload = result()) {
  faux.setResponses([fauxAssistantMessage(fauxText(JSON.stringify(payload)))]);
  const response = await request("/project-insights", {
    projectId: project.id,
    title: "文章建议",
    sourceText,
  });
  expect(response.status).toBe(201);
  const started = (await response.json()) as ProjectInsight;
  await vi.waitFor(() => expect(container.insights.get(started.id).status).not.toBe("analyzing"));
  return container.insights.get(started.id);
}
it("只读分析留下来源和成果，不执行工具或读取隐藏凭据", async () => {
  const record = await analyze();
  expect(record.status).toBe("ready");
  expect(record.reviewedFiles).toEqual(["README.md"]);
  expect(record.suggestions[0]?.sourceQuote).toBe("保留任务目标、约束与未完成事项");
  expect((await container.tasks.get(record.analysisTaskId))?.purpose).toBe("reference_analysis");
  const events = await container.tasks.eventsAfter({
    taskId: record.analysisTaskId,
    after: 0,
    limit: 500,
  });
  expect(events.some(({ event }) => event.type === "tool_call")).toBe(false);
  expect((await container.tasks.listArtifacts(record.analysisTaskId))[0]?.content).toContain(
    "README.md",
  );
  expect(readFileSync(join(project.path, "README.md"), "utf8")).toContain("提供聊天功能");
});
it("无法核对原文或代码路径的建议不会发布", async () => {
  for (const invalid of [result("missing.ts"), result("README.md", "并不存在的文章原文")]) {
    const record = await analyze(invalid);
    expect(record.status).toBe("failed");
    expect(record.error).toContain("无法核对");
    expect(record.suggestions).toEqual([]);
  }
});
it("勾选建议只创建一次开发任务，保留来源与验收条件", async () => {
  const record = await analyze();
  faux.setResponses([fauxAssistantMessage(fauxText("已核实任务"))]);
  const suggestion = record.suggestions[0]!;
  const count = (await container.tasks.list()).length;
  expect(
    (await request(`/project-insights/${record.id}/tasks`, { ids: [suggestion.id, "foreign"] }))
      .status,
  ).toBe(400);
  expect(await container.tasks.list()).toHaveLength(count);
  const first = (await (
    await request(`/project-insights/${record.id}/tasks`, { ids: [suggestion.id, suggestion.id] })
  ).json()) as Task[];
  const second = (await (
    await request(`/project-insights/${record.id}/tasks`, { ids: [suggestion.id] })
  ).json()) as Task[];
  expect(first).toHaveLength(1);
  expect(second[0]?.id).toBe(first[0]?.id);
  expect(await container.tasks.list()).toHaveLength(count + 1);
  expect(first[0]?.goal).toContain(suggestion.sourceQuote);
  expect(first[0]?.goal).toContain(suggestion.acceptance[0]);
  await vi.waitFor(async () =>
    expect((await container.tasks.get(first[0]!.id))?.status).toBe("awaiting_review"),
  );
  expect((await container.tasks.listRuns(first[0]!.id))[0]?.input.workspace).toBe(project.path);
});
it("资料分析记录不能经通用任务续跑获得工具权限", async () => {
  const record = await analyze();
  const response = await request(`/tasks/${record.analysisTaskId}/runs`, {
    trigger: "followup",
    message: "修改文件",
  });
  if (response.status === 201 || response.status === 200) {
    await vi.waitFor(async () =>
      expect((await container.tasks.get(record.analysisTaskId))?.status).toBe("failed"),
    );
    expect((await container.tasks.listRuns(record.analysisTaskId)).at(-1)?.resultError).toContain(
      "资料分析",
    );
  } else {
    expect(response.status).toBe(409);
  }
  expect(
    (
      await container.tasks.eventsAfter({ taskId: record.analysisTaskId, after: 0, limit: 500 })
    ).some(({ event }) => event.type === "tool_call"),
  ).toBe(false);
});
it("公开文章读取拒绝本机和内网，失败后仍支持粘贴正文分析", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "::1", "::ffff:127.0.0.1"])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(() => publicSourceUrl("file:///C:/Windows/win.ini")).toThrow();
  expect(() => publicSourceUrl("https://user:password@example.com/article")).toThrow();
  await expect(readPublicArticle("http://127.0.0.1/article")).rejects.toThrow("公网");
  expect((await analyze()).status).toBe("ready");
});
it("取消分析不发布建议，重启后中断记录可恢复正文重试", async () => {
  faux.setResponses([fauxAssistantMessage(fauxText(JSON.stringify(result())))]);
  const started = await container.insights.start({ projectId: project.id, sourceText });
  expect((await request(`/tasks/${started.analysisTaskId}/cancel`, {})).status).toBe(200);
  await vi.waitFor(() => expect(container.insights.get(started.id).status).toBe("failed"));
  expect(container.insights.get(started.id).suggestions).toEqual([]);
  expect(container.insights.get(started.id).sourceText).toBe(sourceText);
  expect((await container.tasks.getRun(started.analysisRunId))?.status).toBe("cancelled");
  const records = new Collection<ProjectInsight>(container.dbHandle.db, "projectInsights");
  records.put({ ...started, id: "interrupted-record", status: "analyzing" });
  const restarted = new ProjectInsightService(
    container.dbHandle.db,
    container.projects,
    container.tasks,
    container.providers,
    () => undefined,
  );
  expect(restarted.get("interrupted-record")).toMatchObject({ status: "failed", sourceText });
  expect(restarted.get("interrupted-record").error).toContain("重启");
  expect((await analyze()).status).toBe("ready");
  await restarted.dispose();
});
