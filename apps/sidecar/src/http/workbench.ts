import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const TICKET_TTL = 2 * 60_000;
const SESSION_TTL = 24 * 60 * 60_000;
const MAX_ENTRIES = 64;
const freshSecret = () => randomBytes(32).toString("hex");
const cookieName = (c: Context) => `agentdesk-web-${new URL(c.req.url).port}`;

const CONNECT_SCRIPT = `
const status = document.getElementById('status');
async function connect() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
  history.replaceState(null, '', '/connect');
  if (!ticket) {
    status.textContent = '请在终端运行 agentdesk web，使用新链接打开工作台。';
    return;
  }
  status.textContent = '正在连接本机服务…';
  try {
    const response = await fetch('/auth/exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }), credentials: 'same-origin'
    });
    if (!response.ok) throw new Error();
    location.replace('/');
  } catch { status.textContent = '连接已失效，请在终端重新运行 agentdesk web。'; }
}
window.addEventListener('hashchange', connect);
connect();
`;

const CONNECT_PAGE = `<!doctype html><html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>打开 AgentDesk 工作台</title>
<link rel="icon" href="/agentdesk.svg" type="image/svg+xml">
<style>body{margin:0;background:#0d100f;color:#eff5f2;font:15px/1.8 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{max-width:460px;padding:40px}img{width:64px;height:64px}h1{font-size:26px;letter-spacing:-.5px}p{color:#9faeaa}code{color:#79e2b0;background:#19221e;padding:6px 12px;border-radius:8px}</style>
</head><body><main><img src="/agentdesk.svg" alt="AgentDesk"><h1>你的 Agent 工作台</h1>
<p id="status">正在连接本机服务…</p><code>agentdesk web</code>
<p>模型、对话与编码任务，与当前 CLI 实例同步。</p></main>
<script src="/connect.js" defer></script></body></html>`;

/** 仅由 CLI 启用：短期一次性链接换取浏览器会话，不把 CLI 主令牌交给网页。 */
export function createWorkbench(webRoot: string) {
  const tickets = new Map<string, number>();
  const sessions = new Map<string, number>();
  const prune = (entries: Map<string, number>) => {
    for (const [key, expires] of entries) if (expires <= Date.now()) entries.delete(key);
    while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  };
  const sameOrigin = (c: Context) => {
    const origin = new URL(c.req.url).origin;
    const supplied = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    return (
      (!supplied || supplied === origin) && (!site || site === "same-origin" || site === "none")
    );
  };
  const authorize = (c: Context) => {
    if (!sameOrigin(c)) return false;
    if (!["GET", "HEAD"].includes(c.req.method) && !c.req.header("origin")) return false;
    const session = getCookie(c, cookieName(c));
    return !!session && (sessions.get(session) ?? 0) > Date.now();
  };
  const available = () => existsSync(resolve(webRoot, "index.html"));
  const register = (app: Hono) => {
    // 拒绝 DNS rebinding；浏览器会话也不能由其他本机端口的页面使用。
    app.use("*", async (c, next) => {
      if (new URL(c.req.url).hostname !== "127.0.0.1") return c.text("Invalid host", 403);
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Frame-Options", "DENY");
      await next();
    });
  };
  const routes = (app: Hono) => {
    // 此路由位于现有 /api/* 鉴权之后。
    app.post("/api/cli/web-session", (c) => {
      if (!available())
        return c.json(
          { error: { message: "当前安装缺少工作台页面，请更新 CLI 后重启服务。" } },
          503,
        );
      prune(tickets);
      const ticket = freshSecret();
      const expiresAt = Date.now() + TICKET_TTL;
      tickets.set(ticket, expiresAt);
      c.header("Cache-Control", "no-store");
      return c.json({ path: `/connect#ticket=${ticket}`, expiresAt });
    });
    app.post("/auth/exchange", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!sameOrigin(c) || c.req.header("origin") !== new URL(c.req.url).origin)
        return c.text("Forbidden", 403);
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.text("Invalid content type", 415);
      const body: unknown = await c.req.json().catch(() => null);
      const ticket = body && typeof body === "object" && "ticket" in body ? body.ticket : null;
      if (typeof ticket !== "string" || (tickets.get(ticket) ?? 0) <= Date.now())
        return c.text("Expired link", 401);
      tickets.delete(ticket);
      prune(sessions);
      const session = freshSecret();
      sessions.set(session, Date.now() + SESSION_TTL);
      setCookie(c, cookieName(c), session, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        maxAge: SESSION_TTL / 1000,
      });
      return c.json({ ok: true });
    });
    app.get("/connect", (c) => {
      c.header("Cache-Control", "no-store");
      return c.html(CONNECT_PAGE);
    });
    app.get("/connect.js", (c) => {
      c.header("Cache-Control", "no-store");
      return c.body(CONNECT_SCRIPT, 200, { "Content-Type": "text/javascript; charset=utf-8" });
    });
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/")) return next();
      c.header("Cache-Control", "no-store");
      if (c.req.path === "/" && !authorize(c)) return c.html(CONNECT_PAGE);
      let pathname: string;
      try {
        pathname = decodeURIComponent(c.req.path);
      } catch {
        return c.notFound();
      }
      if (pathname === "/index.html") return c.redirect("/");
      if (pathname !== "/" && pathname !== "/agentdesk.svg" && !pathname.startsWith("/assets/"))
        return c.notFound();
      if (pathname.includes("\\") || pathname.includes("\0")) return c.notFound();
      try {
        const root = await realpath(webRoot);
        const file = await realpath(
          resolve(root, pathname === "/" ? "index.html" : `.${pathname}`),
        );
        const rel = relative(root, file);
        if (rel.startsWith("..") || isAbsolute(rel)) return c.notFound();
        const mime: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        const type = mime[extname(file)];
        if (!type) return c.notFound();
        return c.body(new Uint8Array(await readFile(file)), 200, { "Content-Type": type });
      } catch {
        return c.notFound();
      }
    });
  };
  return { authorize, register, routes, available };
}
