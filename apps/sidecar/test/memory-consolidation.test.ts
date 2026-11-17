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

describe("memory consolidation", () => {
  it("核心笔记进入上下文，没有原话出处的自动证据会被丢掉", () => {
    const memory = createMemory();
    memory.store({ text: "用户偏好深色界面主题", kind: "preference", source: "tool" });
    const ungrounded = memory.store({
      text: "用户决定每周回顾一次记忆",
      kind: "decision",
      source: "auto",
      evidence: "模型自己编的一句",
    });

    expect(ungrounded.memory.evidence).toBeNull();
    expect(memory.formatContext("无关问题")).toContain("用户偏好深色界面主题");
    expect(memory.formatContext("无关问题")).toContain("核心笔记");
  });

  it("凑满一批后写情景摘要，纠正后旧摘要失效", () => {
    const memory = createMemory();
    const first = memory.store({
      text: "项目决定使用 MySQL",
      kind: "decision",
      source: "tool",
    }).memory;
    for (let index = 0; index < 5; index += 1) {
      memory.store({
        text: `项目事实编号 ${index} 使用独立配置`,
        kind: "fact",
        source: "tool",
      });
    }

    const episode = handle?.raw
      .prepare(
        "SELECT status, text FROM memory_summaries WHERE kind = 'episode' AND status = 'active'",
      )
      .get() as { status: string; text: string } | undefined;
    expect(episode?.text).toContain("项目决定使用 MySQL");

    memory.correct(first.id, { text: "项目决定改用 Postgres" });
    const episodes = handle?.raw
      .prepare(
        "SELECT status, text FROM memory_summaries WHERE kind = 'episode' ORDER BY updated_at",
      )
      .all() as Array<{ status: string; text: string }>;
    expect(
      episodes.some((item) => item.status === "stale" && item.text.includes("使用 MySQL")),
    ).toBe(true);
    expect(
      episodes.some((item) => item.status === "active" && item.text.includes("使用 MySQL")),
    ).toBe(false);
    expect(memory.formatContext("配置")).not.toContain("使用 MySQL");
    expect(memory.formatContext("配置")).toContain("改用 Postgres");
  });

  it("情景摘要命中时补回尚未被关键词召回的引用", () => {
    const memory = createMemory();
    const cited = memory.store({
      text: "窗口固定在周二",
      kind: "decision",
      source: "tool",
    }).memory;
    handle?.raw
      .prepare(
        `INSERT INTO memory_summaries
        (id, namespace, kind, text, citations, status, conversation_id, created_at, updated_at)
        VALUES ('episode-1', 'user', 'episode', ?, ?, 'active', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run("发布节奏需要单独确认", JSON.stringify([cited.id]));

    const prompt = memory.formatContext("发布节奏");
    expect(prompt).toContain("情景摘要");
    expect(prompt).toContain("窗口固定在周二");
    expect(memory.recall("发布节奏")).toEqual([]);
  });
});
