import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createContainer, type Container } from "../src/container";
import { loadConfig } from "../src/config";
import { createApp } from "../src/http/app";

let container: Container;
beforeAll(async () => {
  container = await createContainer(
    loadConfig({
      AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-chat-stream-")),
      AGENTDESK_TOKEN: "chat-stream-test",
    }),
    { inMemory: true },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => container.dispose());

for (const ending of ["complete", "disconnect", "error"] as const) {
  it(`聊天等待期间发送心跳，${ending} 后释放定时器`, async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    let signal!: AbortSignal;
    vi.spyOn(container.chat, "send").mockImplementation(async (_input, emit, currentSignal) => {
      signal = currentSignal;
      emit({ type: "conversation", conversationId: "waiting" });
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      if (!signal.aborted) emit({ type: "done", messageId: "finished" });
      return "waiting";
    });
    const response = await createApp(container).request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "chat-stream-test" },
      body: JSON.stringify({ message: "等待审批" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toContain('"type":"conversation"');
      for (let tick = 0; tick < 2; tick++) {
        let received: ReadableStreamReadResult<Uint8Array> | undefined;
        const next = reader.read().then((result) => {
          received = result;
        });
        await vi.advanceTimersByTimeAsync(15_000);
        expect(received).toBeDefined();
        expect(decoder.decode(received?.value)).toBe(": keep-alive\n\n");
        await next;
      }
      expect(signal.aborted).toBe(false);
      if (ending === "disconnect") {
        await reader.cancel();
        expect(signal.aborted).toBe(true);
      } else {
        if (ending === "error") fail(new Error("chat failed"));
        else finish();
        const final = decoder.decode((await reader.read()).value);
        expect(final).toContain(ending === "error" ? '"type":"error"' : '"type":"done"');
        expect((await reader.read()).done).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await reader.cancel();
      reader.releaseLock();
    }
  });
}
