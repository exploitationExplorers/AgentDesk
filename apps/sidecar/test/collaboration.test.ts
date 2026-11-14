import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CollaborationMessage, CollaborationRoom, Provider } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { Collection } from "../src/db/collection";
import { CollaborationService } from "../src/services/collaboration";
import type {
  CollaborationExecutor,
  CollaborationTurn,
} from "../src/services/collaboration-executor";

let database: DbHandle;
let service: CollaborationService;
const provider: Provider = {
  id: "configured",
  name: "测试模型",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1/v1",
  models: ["test-model"],
  defaultModel: "test-model",
  enabled: true,
  hasKey: true,
  source: "manual",
  createdAt: "2026-11-13T00:00:00.000Z",
};
const run = vi.fn<CollaborationExecutor["run"]>();
const providers = { list: () => [provider], validateSelection: () => provider };
const approvals = { get: async () => undefined };

beforeEach(() => {
  database = openDatabase(":memory:");
  provider.enabled = true;
  run.mockReset();
  run.mockImplementation(async (turn) => ({
    text: `${turn.role} 已核对 https://example.com/report`,
    toolCalls: [],
  }));
  service = new CollaborationService(database.db, providers, { run }, approvals);
});
afterEach(async () => {
  await service.dispose();
  database.close();
  vi.useRealTimers();
});

async function room(maxRounds = 1) {
  const first = await service.createMember({
    name: "调研员",
    agent: "research",
    modelSelection: { providerId: provider.id, model: "test-model" },
  });
  const second = await service.createMember({
    name: "核对员",
    agent: "reviewer",
    modelSelection: { providerId: provider.id, model: "test-model" },
  });
  return service.createRoom({
    name: "核查小组",
    topic: "核对真实来源",
    maxRounds,
    participants: [
      { memberId: first.id, role: "research" },
      { memberId: second.id, role: "verify" },
    ],
  });
}
async function settled(id: string, status: CollaborationRoom["status"]) {
  await expect.poll(async () => (await service.detail(id)).room.status).toBe(status);
  // 状态持久化与内存执行锁的 finally 位于相邻微任务，显式让收尾完成。
  await new Promise<void>((resolve) => setImmediate(resolve));
  return service.detail(id);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("冻结同一毫秒下并发消息仍有唯一连续序号，三阶段引用按提交顺序持久化", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-13T00:00:00.000Z"));
  const current = await room();
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      service.postMessage(current.id, {
        requestId: `parallel-${index}`,
        content: `补充资料 ${index}`,
      }),
    ),
  );
  const before = await service.detail(current.id);
  expect(before.messages.map((message) => message.seq)).toEqual(
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  await service.discuss(current.id, { requestId: "start", content: "开始交叉核查" });
  const detail = await settled(current.id, "awaiting_decision");
  expect(detail.messages.map((message) => message.seq)).toEqual(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  expect(new Set(detail.messages.map((message) => message.createdAt)).size).toBe(1);
  const agents = detail.messages.filter((message) => message.author.kind === "agent");
  expect(agents.map((message) => message.role)).toEqual(["research", "verify", "summarize"]);
  expect(agents.map((message) => message.replyToId)).toEqual(
    detail.messages.slice(12, 15).map((message) => message.id),
  );
  expect(agents[2]?.evidence).toEqual([{ url: "https://example.com/report", kind: "citation" }]);
  expect(run.mock.calls[1]?.[0].history.at(-1)?.id).toBe(agents[0]?.id);
  expect(run.mock.calls[2]?.[0].history.at(-1)?.id).toBe(agents[1]?.id);
});

it("相同请求幂等且不同内容不能复用请求 ID，客户端不能伪造作者、跨房间引用或点名", async () => {
  const current = await room();
  const input = { requestId: "once", content: "请核对" };
  await Promise.all([
    service.postMessage(current.id, input),
    service.postMessage(current.id, input),
  ]);
  expect((await service.detail(current.id)).messages).toHaveLength(1);
  await expect(service.postMessage(current.id, { ...input, content: "另一条" })).rejects.toThrow(
    "requestId",
  );
  await expect(
    service.postMessage(current.id, { ...input, requestId: "forged", author: { kind: "agent" } }),
  ).rejects.toThrow();
  await expect(
    service.postMessage(current.id, {
      ...input,
      requestId: "bad-reply",
      replyToId: "another-room-message",
    }),
  ).rejects.toThrow("引用消息");
  await expect(
    service.postMessage(current.id, {
      ...input,
      requestId: "bad-mention",
      mentionIds: ["outsider"],
    }),
  ).rejects.toThrow("点名成员");
  await service.discuss(current.id, { requestId: "run-once" });
  await service.discuss(current.id, { requestId: "run-once" });
  await settled(current.id, "awaiting_decision");
  expect(run).toHaveBeenCalledTimes(3);
  expect((await service.detail(current.id)).messages[0]?.author).toEqual({
    kind: "owner",
    id: "local-owner",
    name: "你",
  });
});

it("Provider 出错后的重试沿用第一轮，成功结论仍需用户决定且上限不会被绕过", async () => {
  const current = await room();
  run.mockRejectedValueOnce(new Error("Provider 离线"));
  await service.discuss(current.id, { requestId: "first-attempt" });
  expect((await settled(current.id, "failed")).room).toMatchObject({
    round: 1,
    error: "Provider 离线",
  });
  await service.discuss(current.id, { requestId: "retry" });
  const detail = await settled(current.id, "awaiting_decision");
  expect(detail.room.round).toBe(1);
  expect(detail.messages.filter((message) => message.status === "failed")).toHaveLength(1);
  expect(
    detail.messages.filter(
      (message) => message.author.kind === "agent" && message.status === "complete",
    ),
  ).toHaveLength(3);
  await expect(
    service.decide(current.id, { requestId: "over-budget", action: "continue" }),
  ).rejects.toThrow("上限");
  await service.decide(current.id, { requestId: "accept", action: "agree" });
  expect((await service.detail(current.id)).room.status).toBe("accepted");
  await expect(service.discuss(current.id, { requestId: "over-budget-2" })).rejects.toThrow("上限");
});

it("停止立即持久化终态，旧执行器未收尾前拒绝重试，晚到输出不能污染同轮重试", async () => {
  const current = await room();
  const blocked = deferred<{ text: string; toolCalls: [] }>();
  let oldTurn: CollaborationTurn | undefined;
  run.mockImplementationOnce(async (turn) => {
    oldTurn = turn;
    await turn.emit({ type: "text_delta", agent: "research", delta: "已收到的部分输出" });
    return blocked.promise;
  });
  try {
    await service.discuss(current.id, { requestId: "blocking" });
    await expect.poll(() => oldTurn !== undefined).toBe(true);
    const stopped = await service.stop(current.id);
    expect(stopped.room.status).toBe("cancelled");
    expect(oldTurn?.signal.aborted).toBe(true);
    expect(stopped.messages.find((message) => message.author.kind === "agent")).toMatchObject({
      content: "已收到的部分输出",
      status: "cancelled",
    });
    await expect(service.discuss(current.id, { requestId: "too-early" })).rejects.toThrow(
      "已有讨论",
    );
    await oldTurn?.emit({ type: "text_delta", agent: "research", delta: "不应写入的晚到增量" });
    blocked.resolve({ text: "不应写入的晚到最终回复", toolCalls: [] });
    await expect
      .poll(async () => {
        try {
          await service.discuss(current.id, { requestId: "retry-cancelled" });
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
    const detail = await settled(current.id, "awaiting_decision");
    expect(detail.room.round).toBe(1);
    expect(detail.messages.some((message) => message.content.includes("不应写入"))).toBe(false);
    expect(detail.messages.filter((message) => message.status === "cancelled")).toHaveLength(1);
  } finally {
    blocked.resolve({ text: "cleanup", toolCalls: [] });
  }
});

it("重启恢复中断房间和旧消息序号，明确重试沿用同轮且不会自动执行", async () => {
  const current = await room();
  await service.dispose();
  new Collection<CollaborationRoom>(database.db, "collaboration_rooms").put({
    ...current,
    round: 1,
    status: "waiting_approval",
  });
  new Collection<Omit<CollaborationMessage, "seq">>(database.db, "collaboration_messages").put({
    id: "legacy-partial",
    roomId: current.id,
    author: { kind: "agent", id: current.participants[0]!.memberId, name: "调研员" },
    content: "重启前部分输出",
    round: 1,
    status: "streaming",
    mentionIds: [],
    toolCalls: [],
    evidence: [],
    createdAt: current.createdAt,
  });
  service = new CollaborationService(database.db, providers, { run }, approvals);
  const recovered = await service.detail(current.id);
  expect(recovered.room).toMatchObject({ status: "interrupted", round: 1 });
  expect(recovered.messages[0]).toMatchObject({ status: "failed", seq: 1 });
  expect(run).not.toHaveBeenCalled();
  await service.discuss(current.id, { requestId: "after-restart" });
  const detail = await settled(current.id, "awaiting_decision");
  expect(detail.room.round).toBe(1);
  expect(detail.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5]);
});

it("配置失效在执行前明确失败，修复后原请求可提交且不错误消耗轮数", async () => {
  const current = await room();
  provider.enabled = false;
  expect((await service.listMembers()).every((member) => !member.available)).toBe(true);
  await expect(service.discuss(current.id, { requestId: "config-unavailable" })).rejects.toThrow(
    "不可用",
  );
  expect((await service.detail(current.id)).room.round).toBe(0);
  provider.enabled = true;
  await service.discuss(current.id, { requestId: "config-unavailable" });
  expect((await settled(current.id, "awaiting_decision")).room.round).toBe(1);
});
