import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { AppError, ErrorCode } from "@agentdesk/shared";

const State = z.object({
  schemaVersion: z.literal(1),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  instanceId: z.string().uuid(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

/** 只代理编码现场需要的本机接口。CLI 令牌始终留在服务端，不接受任意目标 URL。 */
export function cliMonitorRoutes(
  home = resolve(process.env.AGENTDESK_CLI_HOME ?? join(homedir(), ".agentdesk")),
) {
  const app = new Hono();
  app.all("/cli-monitor/*", async (c) => {
    const path = c.req.path.replace(/^.*\/cli-monitor/, "");
    const readable =
      /^\/(tasks|projects|approvals)$|^\/tasks\/[^/]+(?:\/(events|runs|artifacts))?$/.test(path);
    const writable =
      /^\/(tasks|projects)$|^\/tasks\/[^/]+\/(cancel|runs|review)$|^\/approvals\/[^/]+(?:\/answer)?$/.test(
        path,
      );
    if (!(c.req.method === "GET" && readable) && !(c.req.method === "POST" && writable))
      throw new AppError(ErrorCode.NotFound, "编码现场不支持此接口");
    let state: z.infer<typeof State>;
    try {
      state = State.parse(JSON.parse(await readFile(join(home, "service.json"), "utf8")));
    } catch {
      throw new AppError(
        ErrorCode.BadRequest,
        "未找到正在运行的 CLI，请先执行 pnpm cli。自定义目录请设置 AGENTDESK_CLI_HOME。",
      );
    }
    const base = `http://127.0.0.1:${state.port}/api`;
    const headers = { "Content-Type": "application/json", "X-AgentDesk-Token": state.token };
    try {
      const identity = await fetch(`${base}/cli/instance`, {
        headers,
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
      const actual = (await identity.json()) as { instanceId?: string; pid?: number };
      if (!identity.ok || actual.instanceId !== state.instanceId || actual.pid !== state.pid)
        throw new Error("CLI 实例不匹配");
      const url = new URL(c.req.url);
      url.searchParams.delete("token");
      const response = await fetch(`${base}${path}?${url.searchParams}`, {
        method: c.req.method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        body: c.req.method === "POST" ? await c.req.text() : undefined,
      });
      return new Response(response.body, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      throw new AppError(
        ErrorCode.BadRequest,
        "无法连接 CLI 实例，请检查 pnpm cli status 后重试。",
      );
    }
  });
  return app;
}
