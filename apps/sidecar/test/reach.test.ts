import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReachResult } from "@agentdesk/shared";
import { loadConfig } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";
import { createAgentDefinitions } from "../src/agents/definitions";
import { ReachService } from "../src/services/reach";
import { fetchPublicSource, resolvePublicSource } from "../src/services/public-fetch";

vi.mock("../src/services/public-fetch", () => ({
  fetchPublicSource: vi.fn(),
  resolvePublicSource: vi.fn(),
}));
let container: Container;
beforeAll(async () => {
  const config = {
    ...loadConfig({ AGENTDESK_DATA_DIR: mkdtempSync(join(tmpdir(), "agentdesk-reach-")) }),
    token: "reach-test",
  };
  container = await createContainer(config, { inMemory: true });
});
afterAll(async () => {
  await container.dispose();
});
beforeEach(() => {
  vi.mocked(resolvePublicSource).mockImplementation(async (url) => ({
    url: new URL(url),
    addresses: [{ address: "8.8.8.8", family: 4 }],
  }));
  vi.mocked(fetchPublicSource).mockImplementation(async (url, options) => {
    options?.onRequest?.(new URL(url));
    return {
      status: 200,
      headers: {},
      contentType: "application/json",
      text: JSON.stringify({
        items: [
          { full_name: "owner/repo", html_url: "https://github.com/owner/repo", private: false },
        ],
      }),
    };
  });
  container.reach.updateSettings({ disabledChannels: [] });
});
afterEach(() => vi.clearAllMocks());
const call = (path: string, method = "GET", body?: unknown) =>
  createApp(container).request(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AgentDesk-Token": "reach-test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("Reach service and API", () => {
  it("keeps status/capabilities local and exposes all three native channels", async () => {
    const capabilities = await (await call("/reach/capabilities")).json();
    expect(capabilities.channels.map((c: { id: string }) => c.id)).toEqual([
      "web",
      "github",
      "v2ex",
    ]);
    const status = await (await call("/reach/status")).json();
    expect(status.channels.every((c: { lastCheckedAt: null }) => c.lastCheckedAt === null)).toBe(
      true,
    );
    expect(fetchPublicSource).not.toHaveBeenCalled();
  });

  it("persists channel switches and prevents disabled tools from sending requests", async () => {
    expect((await call("/reach/settings", "PUT", { disabledChannels: ["github"] })).status).toBe(
      200,
    );
    const restarted = new ReachService(container.dbHandle.db, container.secrets);
    expect(restarted.getSettings()).toEqual({ disabledChannels: ["github"] });
    const result = await restarted.run({ channel: "github", action: "search", query: "test" });
    expect(result.error?.code).toBe("NEED_SETUP");
    expect(result.meta.sentTo).toEqual([]);
    expect(fetchPublicSource).not.toHaveBeenCalled();
    restarted.dispose();
  });

  it("rejects unknown channels in settings and invalid action parameters", async () => {
    expect((await call("/reach/settings", "PUT", { disabledChannels: ["unknown"] })).status).toBe(
      400,
    );
    expect((await call("/reach/run", "POST", { channel: "web", action: "read" })).status).toBe(400);
    expect(
      (
        await call("/reach/run", "POST", {
          channel: "web",
          action: "search",
          query: "query",
          limit: 100,
        })
      ).status,
    ).toBe(400);
    expect(fetchPublicSource).not.toHaveBeenCalled();
  });

  it("requires the existing sidecar session token", async () => {
    expect((await createApp(container).request("/api/reach/capabilities")).status).toBe(401);
  });

  it("reuses existing GitHub account credentials without returning them", async () => {
    container.projects.saveAccount({ platform: "github", token: "configured-github-token" });
    const res = await call("/reach/run", "POST", {
      channel: "github",
      action: "search",
      query: "repo",
    });
    const result = ReachResult.parse(await res.json());
    expect(result.ok).toBe(true);
    expect(vi.mocked(fetchPublicSource).mock.calls[0]?.[1]?.headers?.Authorization).toBe(
      "Bearer configured-github-token",
    );
    expect(result.meta.sentTo).toEqual(["api.github.com"]);
    expect(JSON.stringify(result)).not.toContain("configured-github-token");
    expect(container.reach.status().channels.find((entry) => entry.id === "github")?.ok).toBe(true);
  });

  it("registers safe tools for research with cancellation context", async () => {
    const definition = createAgentDefinitions().find((agent) => agent.name === "research")!;
    const selected = container.registry.select(definition.tools);
    expect(
      selected.filter((tool) => tool.name.startsWith("reach.")).map((tool) => tool.name),
    ).toEqual(["reach.capabilities", "reach.status", "reach.search", "reach.read", "reach.query"]);
    const tool = container.registry.get("reach.search")!;
    expect(tool.risk).toBe("safe");
    const result = ReachResult.parse(
      await tool.execute(
        { channel: "github", query: "repo" },
        {
          agent: "research",
          emit: () => {},
          requestApproval: async () => false,
        },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it("identifies URLs without silently reading another GitHub resource", async () => {
    const result = await container.reach.read("https://github.com/owner/repo/blob/main/file.ts");
    expect(result.channel).toBe("github");
    expect(result.error?.code).toBe("BAD_INPUT");
    expect(fetchPublicSource).not.toHaveBeenCalled();
  });

  it("records Jina only when used and validates the nested target", async () => {
    vi.mocked(fetchPublicSource).mockImplementation(async (url, options) => {
      options?.onRequest?.(new URL(url));
      return {
        status: 200,
        headers: {},
        contentType: "text/plain",
        text: url.startsWith("https://r.jina.ai/") ? "Full article" : "short",
      };
    });
    const result = await container.reach.read("https://example.com/article");
    expect(result.backend).toBe("jina");
    expect(result.meta.sentTo).toEqual(["example.com", "r.jina.ai"]);
    expect(resolvePublicSource).toHaveBeenCalledWith(
      "https://example.com/article",
      expect.any(AbortSignal),
    );
  });

  it("prevents requests while a channel is cooling down", async () => {
    const service = new ReachService(container.dbHandle.db, container.secrets);
    vi.mocked(fetchPublicSource).mockResolvedValue({
      status: 429,
      headers: { "retry-after": "120" },
      contentType: "application/json",
      text: "{}",
    });
    const request = { channel: "v2ex", action: "hot" as const };
    expect((await service.run(request)).error?.retryAfterSeconds).toBe(120);
    const second = await service.run(request);
    expect(second.error?.code).toBe("RATE_LIMITED");
    expect(second.meta.attempts).toEqual([]);
    expect(fetchPublicSource).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("does not access the network for pre-cancelled requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await container.reach.run(
      { channel: "github", action: "search", query: "repo" },
      controller.signal,
    );
    expect(result.error?.code).toBe("TIMEOUT");
    expect(fetchPublicSource).not.toHaveBeenCalled();
  });

  it("reports connection timeout as TIMEOUT rather than an upstream protocol failure", async () => {
    vi.mocked(fetchPublicSource).mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    );
    const result = await container.reach.run({ channel: "v2ex", action: "hot" });
    expect(result.error?.code).toBe("TIMEOUT");
  });
});
