import { Hono } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { ChatRequest, type AgentStreamEvent } from "@agentdesk/shared";
import type { Container } from "../../container";
import { errorMessage } from "../../util";

export function chatRoutes({ chat, projectInstructions, providers }: Container) {
  const app = new Hono();

  app.get("/conversations", (c) => c.json(chat.listConversations()));
  app.get("/conversations/:id/messages", (c) => c.json(chat.messages(c.req.param("id"))));
  app.get("/conversations/:id/traces", (c) => c.json(chat.traces(c.req.param("id"))));
  app.patch("/conversations/:id", async (c) => {
    const { title } = z
      .object({ title: z.string().trim().min(1).max(200) })
      .parse(await c.req.json());
    return c.json(chat.renameConversation(c.req.param("id"), title));
  });
  app.delete("/conversations/:id", (c) => {
    chat.deleteConversation(c.req.param("id"));
    return c.body(null, 204);
  });

  /** POST + SSE：一轮对话的全部 Agent 事件流式返回；客户端断开即取消。 */
  app.post("/chat", async (c) => {
    const body = ChatRequest.parse(await c.req.json());
    // 在提交 SSE 响应头之前校验工作区，输入错误保持普通 HTTP 400 响应。
    await projectInstructions.validateWorkspace(body.workspace);
    if (body.modelSelection) providers.validateSelection(body.modelSelection);
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      let pending = Promise.resolve();
      const enqueue = (write: () => Promise<unknown>) => {
        if (controller.signal.aborted) return;
        pending = pending
          .then(async () => {
            if (!controller.signal.aborted) await write();
          })
          .catch((error: unknown) => controller.abort(error));
      };
      const emit = (event: AgentStreamEvent) => {
        enqueue(() => stream.writeSSE({ data: JSON.stringify(event) }));
      };
      // 模型思考、工具执行和审批等待期间也保持连接；注释不进入业务事件或会话记录。
      const heartbeat = setInterval(() => enqueue(() => stream.write(": keep-alive\n\n")), 15_000);
      try {
        await chat.send(body, emit, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) emit({ type: "error", message: errorMessage(error) });
      } finally {
        clearInterval(heartbeat);
        await pending;
      }
    });
  });

  return app;
}
