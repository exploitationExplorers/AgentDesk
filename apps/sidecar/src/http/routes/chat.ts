import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  ChatRequest,
  ConversationPatch,
  ConversationQuery,
  ConversationGroupInput,
  AppError,
  ErrorCode,
  type AgentStreamEvent,
} from "@agentdesk/shared";
import type { Container } from "../../container";
import { errorMessage } from "../../util";
const ClearConversationsInput = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(500) })
  .strict();
export function chatRoutes({ chat, projectInstructions, providers, tasks, autoloop }: Container) {
  const app = new Hono();
  app.get("/conversations", (c) =>
    c.json(chat.listConversations(ConversationQuery.parse(c.req.query()))),
  );
  // 静态路径须放在 /conversations/:id 之前，避免被当成 id。
  app.post("/conversations/clear", async (c) => {
    const body = ClearConversationsInput.parse(await c.req.json());
    return c.json(await chat.clearConversations(body.ids));
  });
  app.get("/conversations/:id", (c) => c.json(chat.getConversation(c.req.param("id"))));
  app.get("/conversations/:id/messages", async (c) =>
    c.json(await chat.messages(c.req.param("id"))),
  );
  app.get("/conversations/:id/traces", (c) => c.json(chat.traces(c.req.param("id"))));
  app.patch("/conversations/:id", async (c) => {
    const patch = ConversationPatch.parse(await c.req.json());
    return c.json(await chat.patchConversation(c.req.param("id"), patch));
  });
  app.delete("/conversations/:id", async (c) => {
    await chat.deleteConversation(c.req.param("id"));
    return c.body(null, 204);
  });
  app.get("/conversation-groups", (c) => c.json(chat.conversations.listGroups()));
  app.post("/conversation-groups", async (c) => {
    const body = ConversationGroupInput.parse(await c.req.json());
    return c.json(chat.conversations.createGroup(body), 201);
  });
  app.patch("/conversation-groups/:id", async (c) => {
    const body = ConversationGroupInput.parse(await c.req.json());
    return c.json(chat.conversations.renameGroup(c.req.param("id"), body));
  });
  app.delete("/conversation-groups/:id", (c) => {
    chat.conversations.deleteGroup(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/conversations/:id/stop", async (c) => {
    const task = await tasks.findByConversation(c.req.param("id"));
    if (task?.automationId) {
      await autoloop.cancelTask(task.id);
      return c.body(null, 204);
    }
    chat.stop(c.req.param("id"));
    return c.body(null, 204);
  });
  /** 页面连接只是观察者；任务只在用户明确停止或服务退出时取消。 */
  app.post("/chat", async (c) => {
    const body = ChatRequest.parse(await c.req.json());
    if (body.conversationId && (await tasks.findByConversation(body.conversationId))?.automationId)
      throw new AppError(ErrorCode.Conflict, "请通过自动化会话中的回答或继续修改操作提交请求");
    // 在提交 SSE 响应头之前校验工作区，输入错误保持普通 HTTP 400 响应。
    await projectInstructions.validateWorkspace(
      await chat.conversationWorkspace(body.conversationId, body.workspace),
    );
    if (body.modelSelection) providers.validateSelection(body.modelSelection);
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      let disconnected = false;
      const disconnect = () => {
        disconnected = true;
        clearInterval(heartbeat);
      };
      let pending = Promise.resolve();
      const enqueue = (write: () => Promise<unknown>) => {
        if (disconnected) return;
        pending = pending
          .then(async () => {
            if (!disconnected) await write();
          })
          .catch(disconnect);
      };
      const emit = (event: AgentStreamEvent) => {
        enqueue(() => stream.writeSSE({ data: JSON.stringify(event) }));
      };
      // 模型思考、工具执行和审批等待期间也保持连接；注释不进入业务事件或会话记录。
      const heartbeat = setInterval(() => enqueue(() => stream.write(": keep-alive\n\n")), 15000);
      stream.onAbort(disconnect);
      try {
        await chat.send(body, emit, controller.signal);
      } catch (error) {
        if (!disconnected) emit({ type: "error", message: errorMessage(error) });
      } finally {
        clearInterval(heartbeat);
        await pending;
      }
    });
  });
  return app;
}
