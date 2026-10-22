import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { MemoryService } from "../src/services/memory";

let handle: DbHandle | undefined;

afterEach(() => {
  handle?.close();
  handle = undefined;
});

function createMemory(): MemoryService {
  handle = openDatabase(":memory:");
  return new MemoryService(handle.raw, { resolve: async () => [] });
}

describe("memory", () => {
  it("按相关度召回，不返回没有共同关键词的记忆", () => {
    const memory = createMemory();
    memory.store({ text: "用户偏好深色界面主题", kind: "preference", source: "tool" });
    memory.store({ text: "生产数据库是 Postgres 16", kind: "fact", source: "tool" });

    const hits = memory.recall("界面主题");
    expect(hits[0]?.text).toBe("用户偏好深色界面主题");
    expect(hits.some((item) => item.text.includes("Postgres"))).toBe(false);
  });

  it("同一命名空间正文相同则不新增", () => {
    const memory = createMemory();
    const first = memory.store({
      text: "用户偏好深色界面主题",
      kind: "preference",
      source: "tool",
    });
    const second = memory.store({
      text: "  用户偏好深色界面主题  ",
      kind: "fact",
      source: "auto",
    });

    expect(second.created).toBe(false);
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.kind).toBe("fact");
    expect(memory.list()).toHaveLength(1);
  });

  it("forget 之后召回不到", () => {
    const memory = createMemory();
    const stored = memory.store({
      text: "用户偏好深色界面主题",
      kind: "preference",
      source: "tool",
    });
    expect(memory.forget(stored.memory.id)).toEqual({ id: stored.memory.id, deleted: true });
    expect(memory.recall("界面主题")).toEqual([]);
    expect(memory.list()).toEqual([]);
  });

  it("抽取失败时返回空列表", async () => {
    handle = openDatabase(":memory:");
    const memory = new MemoryService(handle.raw, {
      resolve: async () => {
        throw new Error("没有可用的模型");
      },
    });
    await expect(
      memory.captureFromTurn({
        userText: "我喜欢深色界面",
        assistantText: "好的，以后按深色来。",
        conversationId: "c1",
      }),
    ).resolves.toEqual([]);
    expect(memory.list()).toEqual([]);
  });
});
