import { describe, expect, it } from "vitest";
import { OrderedEventSink } from "../src/event-sink";

describe("ordered async event persistence", () => {
  it("preserves order and flush waits for commit", async () => {
    const committed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = new OrderedEventSink(async (event) => {
      if (event.type === "text_delta" && event.delta === "first") await gate;
      if (event.type === "text_delta") committed.push(event.delta);
    });
    sink.emit({ type: "text_delta", delta: "first", agent: "code" });
    sink.emit({ type: "text_delta", delta: "second", agent: "code" });
    expect(committed).toEqual([]);
    release();
    await sink.flush();
    expect(committed).toEqual(["first", "second"]);
  });
  it("propagates failed commit and does not write later events", async () => {
    let writes = 0;
    const sink = new OrderedEventSink(async () => {
      writes++;
      throw new Error("db unavailable");
    });
    sink.emit({ type: "text_delta", delta: "a", agent: "code" });
    sink.emit({ type: "text_delta", delta: "b", agent: "code" });
    await expect(sink.flush()).rejects.toThrow("db unavailable");
    expect(writes).toBe(1);
    expect(() => sink.emit({ type: "text_delta", delta: "c", agent: "code" })).toThrow(
      "db unavailable",
    );
  });
  it("bounds buffered data when storage stalls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = new OrderedEventSink(() => gate);
    sink.emit({ type: "text_delta", delta: "a", agent: "code" });
    expect(() =>
      sink.emit({ type: "text_delta", delta: "x".repeat(5 * 1024 * 1024), agent: "code" }),
    ).toThrow("capacity");
    release();
    await expect(sink.flush()).rejects.toThrow("capacity");
  });
});
