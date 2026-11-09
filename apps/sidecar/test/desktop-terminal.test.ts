import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type * as NodeFs from "node:fs";
import type { SidecarConfig } from "../src/config";

const mock = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn(() => true) }));
vi.mock("node-pty", () => ({ spawn: mock.spawn }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: mock.exists,
}));
import { desktopTerminal } from "../src/desktop-terminal";

describe("desktop CLI terminal", () => {
  const origin = "http://localhost:1420";
  const config = { allowedOrigins: [origin] } as SidecarConfig;
  let data: (value: string) => void;
  let exit: (value: { exitCode: number }) => void;
  let child: {
    onData: ReturnType<typeof vi.fn>;
    onExit: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    child = {
      onData: vi.fn((fn) => {
        data = fn;
      }),
      onExit: vi.fn((fn) => {
        exit = fn;
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    mock.spawn.mockReset().mockReturnValue(child);
  });
  it("restricts origins and preserves input, output and the running session", async () => {
    const session = desktopTerminal(config);
    const app = new Hono().route("/terminal", session.routes);
    const call = (path: string, body: unknown = {}, requestOrigin = origin) =>
      app.request(`/terminal/${path}`, {
        method: "POST",
        headers: { origin: requestOrigin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await call("start", {}, "https://untrusted.example")).status).toBe(403);
    const first = (await (await call("start")).json()) as { generation: number };
    await call("start");
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    data!("hello");
    const read = await (await call("read", { generation: first.generation, cursor: 0 })).json();
    expect(read).toMatchObject({ data: "hello", cursor: 5, exitCode: null });
    await call("input", { generation: first.generation, data: "/help\r" });
    await call("resize", { generation: first.generation, cols: 80, rows: 24 });
    expect(child.write).toHaveBeenCalledWith("/help\r");
    expect(child.resize).toHaveBeenCalledWith(80, 24);
    expect((await call("input", { generation: first.generation - 1, data: "x" })).status).toBe(400);
    exit!({ exitCode: 0 });
    expect(
      await (await call("read", { generation: first.generation, cursor: 5 })).json(),
    ).toMatchObject({ data: "", exitCode: 0 });
    await call("restart");
    expect((await (await call("start")).json()).generation).toBe(first.generation + 1);
    session.close();
    expect(child.kill).toHaveBeenCalled();
  });
});
