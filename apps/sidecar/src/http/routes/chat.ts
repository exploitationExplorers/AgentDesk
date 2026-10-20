import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentStreamEvent } from "@agentdesk/shared";
import type { Container } from "../../container";

export function chatRoutes({ chat }: Container) {
  const app = new Hono();

  app.get("/conversations", (c) => c.json(chat.listConversations()));
  app.get("/conversations/:id/messages", (c) => c.json(chat.messages(c.req.param("id"))));
  app.get("/conversations/:id/traces", (c) => c.json(chat.traces(c.req.param("id"))));
  app.delete("/conversations/:id", (c) => {
    chat.deleteConversation(c.req.param("id"));
    return c.body(null, 204);
  });

  /** POST + SSE：一轮对话的全部 Agent 事件流式返回；客户端断开即取消。 */
  app.post("/chat", async (c) => {
    const body = await c.req.json();
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const pending: Promise<void>[] = [];
      const emit = (event: AgentStreamEvent) => {
        pending.push(stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {}));
      };
      await chat.send(body, emit, controller.signal);
      await Promise.all(pending);
    });
  });

  return app;
}
