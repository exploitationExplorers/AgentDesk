import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Undici from "undici";
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn(),
  agents: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("undici", async (original) => ({
  ...(await original<typeof Undici>()),
  fetch: mocks.fetch,
  Agent: class {
    constructor(options: unknown) {
      mocks.agents(options);
    }
    destroy = mocks.destroy;
  },
}));
import { fetchPublicSource, resolvePublicSource } from "../src/services/public-fetch";

beforeEach(() => {
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.fetch.mockImplementation(
    async () => new Response("content", { headers: { "content-type": "text/plain" } }),
  );
  mocks.destroy.mockResolvedValue(undefined);
});
afterEach(() => vi.resetAllMocks());

describe("public content transport", () => {
  it.each([
    "http://127.0.0.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "https://example.com:3000/",
  ])("blocks %s before requesting it", async (url) => {
    await expect(fetchPublicSource(url)).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS answers", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(fetchPublicSource("https://example.com")).rejects.toThrow("公网");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("pins the validated addresses into the connection lookup", async () => {
    await fetchPublicSource("https://example.com");
    const callback = vi.fn();
    const options = mocks.agents.mock.calls[0]![0] as {
      connect: { lookup: (host: string, opts: { all?: boolean }, cb: typeof callback) => void };
    };
    options.connect.lookup("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("blocks redirects to private IPs", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
    );
    await expect(fetchPublicSource("http://example.com")).rejects.toThrow("公网");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("strips credentials when redirecting to another public origin", async () => {
    const auth: Array<string | null> = [];
    mocks.fetch.mockImplementation(async (_url, options) => {
      auth.push(options.headers.get("authorization"));
      return auth.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://another.example/path" } })
        : new Response("ok");
    });
    await fetchPublicSource("https://example.com", { headers: { Authorization: "Bearer secret" } });
    expect(auth).toEqual(["Bearer secret", null]);
  });

  it("never forwards a POST body across origins", async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: "https://another.example/" } }),
    );
    await expect(
      fetchPublicSource("https://example.com", { method: "POST", body: "query" }),
    ).rejects.toThrow("跨来源");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds response bytes, not only JavaScript characters", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("中文"));
    await expect(fetchPublicSource("https://example.com", { maxBytes: 4 })).rejects.toThrow(
      "大小限制",
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("cancels DNS resolution promptly", async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const request = resolvePublicSource("https://example.com", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
