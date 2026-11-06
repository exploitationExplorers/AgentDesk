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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableCheckpointError,
  DurableExecutionUnknownError,
  Orchestrator,
  ToolRegistry,
  Type,
  defineTool,
  runAgent,
  toWireName,
  type AgentDefinition,
  type DurableCheckpoint,
  type RunAgentOptions,
} from "../src";

let faux: FauxProviderRegistration | undefined;
afterEach(() => faux?.unregister());

const definition: AgentDefinition = {
  name: "orchestrator",
  title: "持久化执行",
  description: "测试",
  systemPrompt: "完成报告",
  tools: ["documents.*", "tasks.*"],
};

function setup() {
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  const options: RunAgentOptions = {
    definition,
    tools: [],
    messages: [{ role: "user", content: "完成报告", timestamp: Date.now() }],
    models: [{ providerId: "faux", providerName: "faux", apiKey: "test", model: faux.getModel() }],
    emit: vi.fn(),
    requestApproval: vi.fn(async () => {
      throw new Error("不能使用内存审批等待");
    }),
  };
  const file = join(mkdtempSync(join(tmpdir(), "agentdesk-durable-test-")), "checkpoint.json");
  const save = (checkpoint: DurableCheckpoint) => writeFileSync(file, JSON.stringify(checkpoint));
  const load = () => JSON.parse(readFileSync(file, "utf8")) as DurableCheckpoint;
  return { options, save, load };
}

describe("持久化 Agent 执行", () => {
  it("写入后多问题挂起，重新读取检查点只继续剩余问题且保留原工具 ID", async () => {
    const { options, save, load } = setup();
    const write = vi.fn(async () => "资料已经落盘");
    options.tools = [
      defineTool({
        name: "documents.write",
        description: "保存资料",
        parameters: Type.Object({}),
        risk: "safe",
        execute: write,
      }),
      defineTool({
        name: "tasks.ask_user",
        description: "提问",
        parameters: Type.Object({}),
        risk: "safe",
        interactionOnly: true,
        execute: async (_args, ctx) => {
          const first = await ctx.requestAnswer!({
            title: "报告范围",
            detail: "选项目",
            risk: "confirm",
            payload: { options: ["甲", "乙"] },
          });
          const second = await ctx.requestAnswer!({
            title: "报告形式",
            detail: "选形式",
            risk: "confirm",
            payload: { options: ["PPT", "Word"] },
          });
          return { first, second };
        },
      }),
    ];
    const writeCall = fauxToolCall(toWireName("documents.write"), {});
    const askCall = fauxToolCall(toWireName("tasks.ask_user"), {});
    faux!.setResponses([
      fauxAssistantMessage([writeCall, askCall], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("报告已完成")),
    ]);

    const first = await runAgent({ ...options, durable: { save } });
    expect(first.status).toBe("suspended");
    expect(write).toHaveBeenCalledTimes(1);
    expect(faux!.state.callCount).toBe(1);
    expect(
      load().messages.some(
        (message) => message.role === "toolResult" && message.toolCallId === writeCall.id,
      ),
    ).toBe(true);
    const waiting = await runAgent({
      ...options,
      models: [],
      durable: { checkpoint: load(), save },
    });
    expect(waiting.status).toBe("suspended");
    expect(faux!.state.callCount).toBe(1);

    const second = await runAgent({
      ...options,
      durable: {
        checkpoint: load(),
        save,
        resume: { interactionId: load().suspension!.id, value: "甲" },
      },
    });
    expect(second.status).toBe("suspended");
    expect(load().suspension!.id).not.toBe(first.status === "suspended" ? first.suspension.id : "");
    expect(faux!.state.callCount).toBe(1);
    const done = await runAgent({
      ...options,
      durable: {
        checkpoint: load(),
        save,
        resume: { interactionId: load().suspension!.id, value: "PPT" },
      },
    });
    expect(done.status).toBe("completed");
    expect(done.text).toBe("报告已完成");
    expect(write).toHaveBeenCalledTimes(1);
    expect(done.toolCalls.find((record) => record.id === askCall.id)?.result).toEqual({
      first: "甲",
      second: "PPT",
    });
    expect(
      done.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId),
    ).toEqual([writeCall.id, askCall.id]);
    expect(faux!.state.callCount).toBe(2);
    expect((await runAgent({ ...options, durable: { checkpoint: load(), save } })).status).toBe(
      "completed",
    );
    expect(faux!.state.callCount).toBe(2);
  });

  it("授权前挂起不执行操作，恢复时校验资源后只执行一次", async () => {
    const { options, save, load } = setup();
    const execute = vi.fn(async () => "发布成功");
    options.tools = [
      defineTool({
        name: "documents.publish",
        description: "发布",
        parameters: Type.Object({ target: Type.String() }),
        risk: "dangerous",
        execute,
      }),
    ];
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("documents.publish"), { target: "internal" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("完成")),
    ]);
    const first = await runAgent({ ...options, durable: { save } });
    expect(first.status === "suspended" && first.suspension.kind).toBe("authorization");
    expect(execute).not.toHaveBeenCalled();
    expect(options.requestApproval).not.toHaveBeenCalled();
    const validateApproval = vi.fn();
    const done = await runAgent({
      ...options,
      durable: {
        checkpoint: load(),
        save,
        resume: { interactionId: load().suspension!.id, value: true },
        validateApproval,
      },
    });
    expect(done.status).toBe("completed");
    expect(validateApproval).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("资源改变时阻止已批准的操作，不把校验失败交给模型继续执行", async () => {
    const { options, save, load } = setup();
    const execute = vi.fn(async () => "不应执行");
    options.tools = [
      defineTool({
        name: "documents.publish",
        description: "发布",
        parameters: Type.Object({}),
        risk: "dangerous",
        execute,
      }),
    ];
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("documents.publish"), {}), {
        stopReason: "toolUse",
      }),
    ]);
    await runAgent({ ...options, durable: { save } });
    await expect(
      runAgent({
        ...options,
        durable: {
          checkpoint: load(),
          save,
          resume: { interactionId: load().suspension!.id, value: true },
          validateApproval: () => {
            throw new Error("target changed");
          },
        },
      }),
    ).rejects.toBeInstanceOf(DurableCheckpointError);
    expect(execute).not.toHaveBeenCalled();
    expect(faux!.state.callCount).toBe(1);
  });

  it.each([false, true])("恢复时风险降低仍保留原授权决定 %s", async (approved) => {
    const { options, save, load } = setup();
    const execute = vi.fn(async () => "已发布");
    let safe = false;
    options.tools = [
      defineTool({
        name: "documents.publish",
        description: "发布",
        parameters: Type.Object({}),
        risk: "dangerous",
        riskFor: () => (safe ? "safe" : "dangerous"),
        execute,
      }),
    ];
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("documents.publish"), {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(fauxText("处理完成")),
    ]);
    await runAgent({ ...options, durable: { save } });
    safe = true;
    const validateApproval = vi.fn();
    const result = await runAgent({
      ...options,
      durable: {
        checkpoint: load(),
        save,
        resume: { interactionId: load().suspension!.id, value: approved },
        validateApproval,
      },
    });
    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(validateApproval).toHaveBeenCalledTimes(approved ? 1 : 0);
  });

  it("完成步骤保存失败会停止，重启把 started 操作视为结果不明且不再写入", async () => {
    const { options, save, load } = setup();
    const execute = vi.fn(async () => "已写入");
    options.tools = [
      defineTool({
        name: "documents.write",
        description: "写入",
        parameters: Type.Object({}),
        risk: "safe",
        execute,
      }),
    ];
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("documents.write"), {}), {
        stopReason: "toolUse",
      }),
    ]);
    const failAfterWrite = (checkpoint: DurableCheckpoint) => {
      if (checkpoint.toolCalls.length > 0) throw new Error("old epoch");
      save(checkpoint);
    };
    await expect(
      runAgent({ ...options, durable: { save: failAfterWrite } }),
    ).rejects.toBeInstanceOf(DurableCheckpointError);
    expect(execute).toHaveBeenCalledOnce();
    await expect(
      runAgent({ ...options, durable: { checkpoint: load(), save } }),
    ).rejects.toBeInstanceOf(DurableExecutionUnknownError);
    expect(execute).toHaveBeenCalledOnce();
    expect(faux!.state.callCount).toBe(1);
    expect(load().phase).toBe("unknown");
  });

  it("模型回复保存失败时业务工具不会执行", async () => {
    const { options, save } = setup();
    const execute = vi.fn(async () => "不应执行");
    options.tools = [
      defineTool({
        name: "documents.write",
        description: "写入",
        parameters: Type.Object({}),
        risk: "safe",
        execute,
      }),
    ];
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("documents.write"), {}), {
        stopReason: "toolUse",
      }),
    ]);
    await expect(
      runAgent({
        ...options,
        durable: {
          save: (checkpoint) => {
            if (checkpoint.phase === "tools") throw new Error("storage failure");
            save(checkpoint);
          },
        },
      }),
    ).rejects.toBeInstanceOf(DurableCheckpointError);
    expect(execute).not.toHaveBeenCalled();
    expect(faux!.state.callCount).toBe(1);
  });

  it("取消工具执行后不再调用模型，重启保留不明结果供核验", async () => {
    const { options, save, load } = setup();
    const controller = new AbortController();
    options.tools = [
      defineTool({
        name: "documents.write",
        description: "写入",
        parameters: Type.Object({}),
        risk: "safe",
        execute: async () => {
          controller.abort();
          throw new Error("cancelled");
        },
      }),
    ];
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("documents.write"), {}), {
        stopReason: "toolUse",
      }),
    ]);
    await expect(
      runAgent({ ...options, signal: controller.signal, durable: { save } }),
    ).rejects.toThrow();
    expect(faux!.state.callCount).toBe(1);
    await expect(
      runAgent({ ...options, durable: { checkpoint: load(), save } }),
    ).rejects.toBeInstanceOf(DurableExecutionUnknownError);
  });

  it("Orchestrator 透传挂起结果，持久化模式不提供不可恢复的委派工具", async () => {
    const { options, save } = setup();
    const registry = new ToolRegistry().register(
      defineTool({
        name: "tasks.ask_user",
        description: "提问",
        parameters: Type.Object({}),
        risk: "safe",
        interactionOnly: true,
        execute: (_args, ctx) =>
          ctx.requestAnswer!({
            title: "范围",
            detail: "请选择",
            risk: "confirm",
            payload: { options: ["甲", "乙"] },
          }),
      }),
    );
    faux!.setResponses([
      fauxAssistantMessage(fauxToolCall(toWireName("tasks.ask_user"), {}), {
        stopReason: "toolUse",
      }),
    ]);
    const orchestrator = new Orchestrator({
      agents: [definition],
      registry,
      resolver: { resolve: async () => options.models },
    });
    const result = await orchestrator.run({
      history: [],
      userMessage: "生成报告",
      emit: options.emit,
      requestApproval: options.requestApproval,
      durable: { save },
    });
    expect(result.status).toBe("suspended");
    expect(faux!.state.callCount).toBe(1);
  });
});
