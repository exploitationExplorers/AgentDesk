import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import * as pty from "node-pty";
import type { SidecarConfig } from "./config";

const MAX_OUTPUT = 1024 * 1024;

export function desktopTerminal(config: SidecarConfig) {
  let terminal: pty.IPty | undefined;
  let output = "";
  let offset = 0;
  let exitCode: number | null = null;
  let generation = 0;
  const routes = new Hono();

  routes.use("/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin || !config.allowedOrigins.includes(origin))
      return c.json({ error: { message: "来源不允许访问终端" } }, 403);
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json"))
      return c.json({ error: { message: "需要 JSON 请求" } }, 415);
    await next();
  });

  routes.post("/start", (c) => {
    if (!terminal && exitCode === null) {
      const here = dirname(fileURLToPath(import.meta.url));
      const bundled = resolve(here, "cli/dist/index.mjs");
      const development = resolve(here, "../../cli/dist/index.mjs");
      const entry = existsSync(bundled) ? bundled : development;
      if (!existsSync(entry))
        return c.json({ error: { message: "找不到 CLI 程序，请先构建 CLI。" } }, 503);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TERM: "xterm-256color",
        AGENTDESK_SKIP_UPDATE: "1",
      };
      for (const key of [
        "AGENTDESK_DATA_DIR",
        "AGENTDESK_TOKEN",
        "AGENTDESK_PORT",
        "AGENTDESK_MASTER_KEY",
        "AGENTDESK_SKILLS_DIR",
        "AGENTDESK_PARENT_STDIN",
      ])
        delete env[key];
      const child = pty.spawn(process.execPath, [entry, "chat"], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: homedir(),
        env: env as Record<string, string>,
      });
      terminal = child;
      generation++;
      child.onData((data) => {
        output += data;
        if (output.length > MAX_OUTPUT) {
          const dropped = output.length - MAX_OUTPUT;
          output = output.slice(dropped);
          offset += dropped;
        }
      });
      child.onExit((event) => {
        if (terminal === child) {
          terminal = undefined;
          exitCode = event.exitCode;
        }
      });
    }
    return c.json({ generation, exitCode });
  });
  routes.post("/read", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const cursor = Number.isSafeInteger(body.cursor) ? body.cursor : 0;
    const reset =
      body.generation !== generation || cursor < offset || cursor > offset + output.length;
    return c.json({
      generation,
      reset,
      data: output.slice(reset ? 0 : cursor - offset),
      cursor: offset + output.length,
      exitCode,
      running: Boolean(terminal),
    });
  });
  routes.post("/input", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (
      typeof body.data !== "string" ||
      body.data.length > 65536 ||
      body.generation !== generation ||
      !terminal
    )
      return c.json({ error: { message: "终端不可用或输入无效" } }, 400);
    terminal.write(body.data);
    return c.json({ ok: true });
  });
  routes.post("/resize", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (
      !Number.isInteger(body.cols) ||
      !Number.isInteger(body.rows) ||
      body.cols < 2 ||
      body.cols > 500 ||
      body.rows < 2 ||
      body.rows > 300 ||
      body.generation !== generation ||
      !terminal
    )
      return c.json({ error: { message: "终端尺寸无效" } }, 400);
    terminal.resize(body.cols, body.rows);
    return c.json({ ok: true });
  });
  routes.post("/restart", (c) => {
    if (terminal) return c.json({ error: { message: "终端仍在运行" } }, 409);
    output = "";
    offset = 0;
    exitCode = null;
    return c.json({ ok: true });
  });
  return {
    routes,
    close: () => {
      terminal?.kill();
      terminal = undefined;
    },
  };
}
