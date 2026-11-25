import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AppError, ErrorCode, HubLinkFields, HubWebEntry, HubSnapshot } from "@agentdesk/shared";
import type { Container } from "../../container";
import { SessionHub } from "../../services/session-hub";
import { sessionSources } from "../../services/session-hub/sources";

export function sessionHubRoutes(container: Container) {
  const app = new Hono();
  let service: SessionHub | undefined;
  const hub = () => (service ??= new SessionHub(container.dbHandle, sessionSources(container)));
  app.use("/session-hub/*", async (c, next) => {
    const origin = c.req.header("origin"),
      url = new URL(c.req.url);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      (origin && origin !== url.origin && !container.config.allowedOrigins.includes(origin))
    )
      throw new AppError(ErrorCode.Forbidden, "请从本机工作台访问会话。");
    if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json"))
      throw new AppError(ErrorCode.Forbidden, "请从本机工作台操作会话。");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.get("/session-hub", async (c) => c.json(await hub().index()));
  app.post("/session-hub/refresh", async (c) => c.json(await hub().index(true)));
  app.post("/session-hub/search", async (c) => {
    const { remote, ...filters } = z
      .object({
        query: z.string().trim().min(1).max(1024),
        tool: z.string().max(32).optional(),
        device: z.string().max(128).optional(),
        onlyPr: z.boolean().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        remote: z.boolean().default(false),
      })
      .parse(await c.req.json());
    return c.json(await hub().search(filters, remote));
  });
  app.post("/session-hub/cloud", async (c) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    hub().setCloud(enabled);
    return c.body(null, 204);
  });
  app.post("/session-hub/pr", async (c) => {
    const { key, ...fields } = HubLinkFields.safeExtend({ key: z.string().max(512) }).parse(
      await c.req.json(),
    );
    await hub().bind(key, fields);
    return c.body(null, 204);
  });
  app.post("/session-hub/web", async (c) => {
    return c.json({ key: hub().addWeb(HubWebEntry.parse(await c.req.json())) });
  });
  app.post(
    "/session-hub/import",
    bodyLimit({
      maxSize: 32 * 1024 * 1024,
      onError: () => {
        throw new AppError(ErrorCode.BadRequest, "请选择小于 32 MB 的设备索引。");
      },
    }),
    async (c) => {
      hub().import(HubSnapshot.parse(await c.req.json()));
      return c.body(null, 204);
    },
  );
  app.post("/session-hub/open", async (c) => {
    const { key } = z.object({ key: z.string().max(512) }).parse(await c.req.json());
    const row = await hub().localRow(key);
    const id = encodeURIComponent(row.id);
    let url: string;
    if (row.tool === "codex") url = `codex://threads/${id}`;
    else if (row.tool === "cursor")
      url = row.id.startsWith("bc-")
        ? `cursor://anysphere.cursor-deeplink/background-agent?bcId=${id}`
        : `cursor://anysphere.cursor-deeplink/agent?id=${id}`;
    else if (row.tool === "claude-desktop") url = `claude://claude.ai/epitaxy/${id}`;
    else if (row.tool === "gemini-desktop") url = `googlegemini://conversation/${id}`;
    else if (row.tool === "grok") url = `grokbot://app/v1/agent?id=${id}`;
    else if (row.tool === "antigravity") {
      if (
        !isAbsolute(row.directory) ||
        !(await stat(row.directory).catch(() => null))?.isDirectory()
      )
        throw new AppError(ErrorCode.NotFound, "此会话的工作目录在本机不可用。");
      try {
        await promisify(execFile)(
          process.platform === "darwin" ? "/usr/bin/open" : "antigravity",
          process.platform === "darwin"
            ? ["-b", "com.google.antigravity", "--", row.directory]
            : [row.directory],
          { timeout: 8000 },
        );
      } catch {
        throw new AppError(
          ErrorCode.IntegrationFailed,
          "无法打开 Antigravity，请确认已安装客户端。",
        );
      }
      return c.body(null, 204);
    } else throw new AppError(ErrorCode.BadRequest, "该来源不支持桌面跳转。");
    const executable =
      process.platform === "darwin"
        ? "/usr/bin/open"
        : process.platform === "win32"
          ? "rundll32.exe"
          : "xdg-open";
    try {
      await promisify(execFile)(
        executable,
        process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
        { timeout: 8000 },
      );
    } catch {
      throw new AppError(ErrorCode.IntegrationFailed, "无法打开原工具，请确认已安装对应客户端。");
    }
    return c.body(null, 204);
  });
  return app;
}
