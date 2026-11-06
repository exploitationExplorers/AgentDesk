import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  type Context,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { toWireName, type ResolvedModel } from "@agentdesk/agent-core";
import type { Task, ToolCallRecord } from "@agentdesk/shared";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { runs } from "../src/db/schema";
import { createApp } from "../src/http/app";

let container: Container;
let faux: FauxProviderRegistration;
let model: ResolvedModel["model"];
let project: string;
beforeAll(async () => {
  container = await createContainer(
    {
      ...loadConfig({
        AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-budget-resume-")),
      }),
      token: "test-token",
    },
    { inMemory: true },
  );
  project = mkdtempSync(join(tmpdir(), "agentdesk-budget-project-"));
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  await container.projects.add(project);
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  model = { ...faux.getModel(), contextWindow: 64_000, maxTokens: 1024 };
  container.providers.resolve = async () => [
    { providerId: "faux", providerName: "faux", model, apiKey: "x" },
  ];
});
afterEach(() => {
  vi.restoreAllMocks();
  model.contextWindow = 64_000;
});
afterAll(async () => {
  faux.unregister();
  await container.dispose();
});

const request = (path: string, body: unknown) =>
  createApp(container).request(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "test-token" },
    body: JSON.stringify(body),
  });

for (const source of ["task", "chat"] as const) {
  it(`${source} 写入成功后触发真实预算中断，失败记录与续跑上下文保留已完成操作`, async () => {
    const path = `budget-${source}.txt`;
    const content = "已经完成的写入，不应重复。";
    const write = container.registry.get("fs.write")!;
    const original = write.execute.bind(write);
    const executed = vi.spyOn(write, "execute").mockImplementation(async (args, ctx) => {
      const result = await original(args, ctx);
      // 第一轮正常调用并真实落盘；下一轮由 agent-core 的预算检查拒绝调用模型。
      model.contextWindow = 128;
      return result;
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(toWireName("fs.write"), { project, path, content, expectedHash: "" }),
        { stopReason: "toolUse" },
      ),
    ]);
    const response = await request(
      source === "task" ? "/tasks" : "/chat",
      source === "task"
        ? { goal: `创建 ${path}`, agent: "code", workspace: project }
        : { message: `创建 ${path}`, agent: "code", workspace: project },
    );
    const stream = source === "chat" ? response.text() : undefined;
    const taskResponse = source === "task" ? ((await response.json()) as Task) : undefined;
    await vi.waitFor(() => expect(container.approvals.list("pending").length).toBeGreaterThan(0));
    await request(`/approvals/${container.approvals.list("pending")[0]!.id}`, { approved: true });
    if (stream) await stream;
    const task =
      taskResponse ?? container.tasks.list().find((item) => item.goal === `创建 ${path}`)!;
    await vi.waitFor(() => expect(container.tasks.get(task.id)?.status).toBe("failed"));
    const first = container.tasks.listRuns(task.id)[0]!;
    expect(first.resultError).toContain("输入预算");
    expect(first.toolCalls).toEqual([
      expect.objectContaining({
        name: "fs.write",
        args: expect.objectContaining({ path }),
        isError: false,
      }),
    ]);
    expect((first.toolCalls as ToolCallRecord[])[0]?.result).toBeDefined();
    const failed = container.chat.messages(task.conversationId).at(-1)!;
    expect(failed.toolCalls).toEqual(first.toolCalls);
    expect(failed.content).toContain("成果会保留");
    expect(failed.toolCalls[0]?.args).toMatchObject({ path, content });
    expect(readFileSync(join(project, path), "utf8")).toBe(content);

    model.contextWindow = 64_000;
    let captured = "";
    faux.setResponses([
      (context: Context) => {
        captured = JSON.stringify(context);
        return fauxAssistantMessage(fauxText("已有写入已保留，只继续后续验证。"));
      },
      fauxAssistantMessage(fauxText('{"memories":[]}')),
    ]);
    if (source === "task") {
      // 同时覆盖旧版本留下 toolCalls=null 的 Run，续跑会回放其持久化事件。
      container.dbHandle.db
        .update(runs)
        .set({ toolCalls: null })
        .where(eq(runs.id, first.id))
        .run();
      const resumed = await request(`/tasks/${task.id}/runs`, {
        trigger: "resume",
        message: "继续验证",
      });
      expect(resumed.status).toBe(201);
      await vi.waitFor(() =>
        expect(
          container.tasks.get(task.id)?.status,
          JSON.stringify(
            container.tasks
              .listRuns(task.id)
              .map(({ status, resultError }) => ({ status, resultError })),
          ),
        ).toBe("awaiting_review"),
      );
    } else {
      const resumed = await request("/chat", {
        conversationId: task.conversationId,
        message: "继续验证",
        agent: "code",
      });
      await resumed.text();
      expect(container.tasks.get(task.id)?.status).toBe("awaiting_review");
    }
    expect(captured).toContain(path);
    expect(captured).toContain("fs.write");
    expect(captured).toContain("完成");
    expect(captured).toContain(
      source === "task" ? "跳过已确认完成的操作" : "内部执行记录，仅用于续跑时核对",
    );
    expect(executed).toHaveBeenCalledOnce();
    expect(readFileSync(join(project, path), "utf8")).toBe(content);
  });
}
