import { describe, expect, it, vi } from "vitest";
import {
  AUTOLOOP_COMMIT,
  AutoloopClient,
  AutoloopClientError,
  isWindowsDriveRelativePath,
  validateAutoloopBaseUrl,
  validateWorkspacePath,
} from "../src/autoloop";

const credentials = { owner: "owner-key", worker: "worker-key", source: "source-key" };
function client(fetchImpl: typeof fetch) {
  return new AutoloopClient({ baseUrl: "http://127.0.0.1:12345", credentials, fetchImpl });
}

describe("Autoloop HTTP 边界", () => {
  it("凭据按请求角色传递，运行 token 不会被当作对象属性或角色名", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ok: true }));
    await client(fetchImpl).started(1, "toString", "session");
    expect(fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({
      Authorization: "Bearer toString",
    });
    await client(fetchImpl).started(1, "owner", "session");
    expect(fetchImpl.mock.calls[1]![1]?.headers).toMatchObject({ Authorization: "Bearer owner" });
  });

  it("拒绝不安全地址、无效编号和非预期上游版本", async () => {
    for (const url of [
      "http://example.com",
      "file:///tmp/hub",
      "http://user@localhost",
      "http://localhost/v1",
      "http://localhost/?x=1",
    ])
      expect(() => validateAutoloopBaseUrl(url)).toThrow();
    expect(validateAutoloopBaseUrl("http://[::1]:1234").hostname).toBe("[::1]");
    expect(validateAutoloopBaseUrl("https://hub.example.com").protocol).toBe("https:");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ok: true, commit: "other" }));
    const hub = client(fetchImpl);
    await expect(hub.health()).rejects.toThrow();
    fetchImpl.mockResolvedValue(Response.json({ ok: true, commit: AUTOLOOP_COMMIT }));
    await hub.health();
    await expect(hub.cancelRun(-1)).rejects.toThrow();
    await expect(hub.getCard(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow();
    await expect(hub.work("", 1)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("错误正文不泄漏到异常，重定向不能转发凭据", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private-token", { status: 403 }));
    const error = await client(fetchImpl)
      .state()
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AutoloopClientError);
    expect(String(error)).not.toContain("private-token");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it("逐字节接收 CRLF/UTF-8 事实，跳过注释与不完整尾帧，保留 null 删除行", async () => {
    const fact = {
      seq: 8,
      type: "card.answered",
      changes: [
        { table: "cards", key: "1", row: { answer: "中文答案" } },
        { table: "timers", key: "1", row: null },
      ],
    };
    const bytes = Buffer.from(
      `: heartbeat\r\n\r\nevent: fact\r\ndata: ${JSON.stringify(fact)}\r\n\r\ndata: {"unfinished":`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const facts = [];
    for await (const item of client(fetchImpl).facts(7, new AbortController().signal))
      facts.push(item);
    expect(facts).toEqual([fact]);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("after=7");
  });

  it("无边界大帧停止读取，主动断开会取消流", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1).fill(65));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    const iterator = client(fetchImpl).facts(0, new AbortController().signal);
    await expect(iterator.next()).rejects.toThrow("帧过大");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("卡片不在有限 owner 快照中时返回 null", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ cards: [], recentCards: [] }));
    expect(await client(fetchImpl).getCard(99)).toBeNull();
  });
});

describe("跨平台工作区路径", () => {
  it("中文和空格路径保持原样，POSIX 语义不受宿主 Windows 影响", () => {
    expect(validateWorkspacePath("D:/开发 项目/报告/../周报", { platform: "win32" })).toBe(
      "D:\\开发 项目\\周报",
    );
    expect(validateWorkspacePath("/工作 区/资料/../报告", { platform: "linux" })).toBe(
      "/工作 区/报告",
    );
    expect(() => validateWorkspacePath("D:/project", { platform: "linux" })).toThrow();
    expect(isWindowsDriveRelativePath("D:")).toBe(true);
    expect(isWindowsDriveRelativePath("D:project")).toBe(true);
    expect(isWindowsDriveRelativePath("D:/project")).toBe(false);
  });

  it.each([
    "D:",
    "D:relative",
    "\\rooted",
    "/rooted",
    "\\\\server\\share",
    "//server/share",
    "\\\\?\\D:\\repo",
    "//?/D:/repo",
    "//./C:/repo",
    "\\??\\C:\\repo",
    "D:/a\0b",
    "D:/file:stream",
    "D:/nul",
    "D:/aux.txt",
    "D:/com1",
    "D:/trailing.",
    "D:/trailing ",
  ])("默认拒绝不稳定或特殊路径 %s", (path) => {
    expect(() => validateWorkspacePath(path, { platform: "win32" })).toThrow();
  });

  it("UNC 必须显式允许且有完整共享名，显式允许仍拒绝设备路径", () => {
    expect(
      validateWorkspacePath("//server/share/中文", { platform: "win32", allowUnc: true }),
    ).toBe("\\\\server\\share\\中文");
    for (const path of ["//server", "//?/D:/repo", "//./C:/repo"])
      expect(() => validateWorkspacePath(path, { platform: "win32", allowUnc: true })).toThrow();
  });
});
