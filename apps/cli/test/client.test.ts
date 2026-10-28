import assert from "node:assert/strict";
import { test } from "node:test";
import { consumeSse, verifyInstance } from "../src/client.js";
import type { AgentStreamEvent } from "@agentdesk/shared";
import { createServer } from "node:http";

test("SSE 逐字节传输中文、CRLF、多行 data 与异步审批", async () => {
  const bytes = new TextEncoder().encode(
    ': heartbeat\r\ndata: {"type":"text_delta",\r\ndata: "delta":"你好，世界"}\r\n\r\ndata: {"type":"done"}\n\n',
  );
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const events: AgentStreamEvent[] = [];
  await consumeSse(stream, async (event) => {
    await Promise.resolve();
    events.push(event);
  });
  assert.deepEqual(events, [{ type: "text_delta", delta: "你好，世界" }, { type: "done" }]);
});

test("SSE 非法数据会报错，不被当作执行成功", async () => {
  const stream = new Response("data: invalid\n\n").body;
  assert.ok(stream);
  await assert.rejects(
    consumeSse(stream, () => {}),
    SyntaxError,
  );
});

test("实例校验需要认证且拒绝同端口上的不同实例", async () => {
  let receivedToken;
  const server = createServer((req, res) => {
    receivedToken = req.headers["x-agentdesk-token"];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ instanceId: "another-instance", pid: process.pid }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(
      verifyInstance({
        port: address.port,
        token: "local-test-token",
        instanceId: "expected",
        pid: process.pid,
        schemaVersion: 1,
        mode: "foreground",
        version: "test",
        startedAt: new Date().toISOString(),
      }),
      /不符/,
    );
    assert.equal(receivedToken, "local-test-token");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
