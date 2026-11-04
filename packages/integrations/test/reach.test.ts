import { describe, expect, it, vi } from "vitest";
import { ReachResult } from "@agentdesk/shared";
import {
  createDefaultReachRegistry,
  makeItem,
  ReachChannelError,
  ReachRegistry,
  type ReachChannelDef,
  type ReachContext,
} from "../src/reach";

const item = (text = "content") =>
  makeItem({ title: "Title", url: "https://example.com", text, partial: false });
const response = (value: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  text: JSON.stringify(value),
});
function context(overrides: Partial<ReachContext> = {}): ReachContext {
  return {
    deadline: Date.now() + 30_000,
    sentTo: new Set(),
    fetch: vi.fn(),
    secret: vi.fn(async () => undefined),
    validateUrl: vi.fn(async () => {}),
    readArticle: vi.fn(async () => "body"),
    ...overrides,
  };
}
function channel(backends: ReachChannelDef["actions"][number]["backends"]): ReachChannelDef {
  return {
    id: "test",
    title: "Test",
    description: "test",
    sendsDataTo: [],
    requires: [],
    actions: [{ name: "read", description: "read", backends }],
  };
}
const params = { target: "https://example.com", limit: 10 };

describe("Reach dispatch", () => {
  it("falls back only after recoverable errors and preserves actual destinations", async () => {
    const registry = new ReachRegistry().register(
      channel([
        {
          id: "first",
          run: async () => {
            throw new ReachChannelError("UPSTREAM_BROKEN", "failed");
          },
        },
        {
          id: "second",
          run: async (_params, ctx) => {
            ctx.sentTo.add("example.com");
            return [item()];
          },
        },
      ]),
    );
    const result = ReachResult.parse(await registry.run("test", "read", params, context()));
    expect(result.ok).toBe(true);
    expect(result.backend).toBe("second");
    expect(result.meta.sentTo).toEqual(["example.com"]);
    expect(result.meta.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
  });

  it.each(["NEED_LOGIN", "RATE_LIMITED", "PLATFORM_BLOCKED", "BAD_INPUT", "NOT_FOUND"] as const)(
    "does not retry %s",
    async (code) => {
      const fallback = vi.fn(async () => [item()]);
      const registry = new ReachRegistry().register(
        channel([
          {
            id: "first",
            run: async () => {
              throw new ReachChannelError(code, "stop");
            },
          },
          { id: "fallback", run: fallback },
        ]),
      );
      expect((await registry.run("test", "read", params, context())).error?.code).toBe(code);
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it("bounds text, metadata and total items and marks partial results", async () => {
    const huge = {
      ...item("x".repeat(20_000)),
      title: "t".repeat(2000),
      extra: { details: "x".repeat(2000) },
    };
    const registry = new ReachRegistry().register(
      channel([{ id: "large", run: async () => Array.from({ length: 30 }, () => huge) }]),
    );
    const result = await registry.run("test", "read", { ...params, limit: 5 }, context());
    expect(result.items).toHaveLength(5);
    expect(result.items.reduce((n, entry) => n + entry.text.length, 0)).toBeLessThanOrEqual(48_000);
    expect(result.items[0]?.text).toHaveLength(12_000);
    expect(result.items[0]?.title).toHaveLength(512);
    expect(result.items[0]?.extra?.details).toHaveLength(512);
    expect(result.items.every((entry) => entry.partial)).toBe(true);
    expect(result.meta.truncated).toBe(true);
  });

  it("cancels an in-flight backend without waiting for it", async () => {
    const controller = new AbortController();
    const registry = new ReachRegistry().register(
      channel([
        {
          id: "hung",
          run: async () => {
            controller.abort();
            return new Promise(() => {});
          },
        },
      ]),
    );
    const result = await registry.run(
      "test",
      "read",
      params,
      context({ signal: controller.signal }),
    );
    expect(result.error?.code).toBe("TIMEOUT");
  });

  it("enforces the total deadline even for an uncooperative adapter", async () => {
    const registry = new ReachRegistry().register(
      channel([{ id: "hung", run: async () => new Promise(() => {}) }]),
    );
    const result = await registry.run(
      "test",
      "read",
      params,
      context({ deadline: Date.now() + 10 }),
    );
    expect(result.error?.code).toBe("TIMEOUT");
  });
});

describe("native channels", () => {
  const registry = createDefaultReachRegistry();
  const exa = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "Title: Example\nURL: https://example.com\nPublished: 2026-11-04\nAuthor: Author\nText:\nSnippet",
        },
      ],
    },
  };

  it.each([false, true])("parses Exa JSON and SSE (SSE=%s)", async (sse) => {
    const fetch = vi.fn<ReachContext["fetch"]>(async () =>
      sse
        ? {
            status: 200,
            contentType: "text/event-stream",
            text: `event: message\ndata: ${JSON.stringify(exa)}\n\ndata: {"method":"notifications/progress"}\n\ndata: [DONE]\n\n`,
          }
        : response(exa),
    );
    const result = await registry.run(
      "web",
      "search",
      { query: "中文 & query", limit: 2 },
      context({ fetch }),
    );
    expect(result.ok).toBe(true);
    expect(result.items[0]).toMatchObject({
      title: "Example",
      text: "Snippet",
      partial: true,
      publishedAt: "2026-11-04",
    });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body!)).toMatchObject({
      params: { arguments: { query: "中文 & query" } },
    });
  });

  it.each([
    response({
      jsonrpc: "2.0",
      id: 1,
      result: { isError: true, content: [{ type: "text", text: "free quota exceeded" }] },
    }),
    response({}, 429),
  ])("returns a terminal quota error", async (reply) => {
    const result = await registry.run(
      "web",
      "search",
      { query: "x", limit: 1 },
      context({ fetch: async () => reply }),
    );
    expect(result.error?.code).toBe("RATE_LIMITED");
  });

  it("falls back to Jina only after validating the target", async () => {
    const fetch = vi.fn(async () => ({ status: 200, contentType: "text/plain", text: "Article" }));
    const ctx = context({
      fetch,
      readArticle: async () => {
        throw new ReachChannelError("UPSTREAM_BROKEN", "empty");
      },
    });
    expect((await registry.run("web", "read", params, ctx)).backend).toBe("jina");
    expect(ctx.validateUrl).toHaveBeenCalledWith(params.target);
    expect(fetch).toHaveBeenCalledWith(`https://r.jina.ai/${params.target}`, expect.anything());
  });

  it("does not forward an invalid URL to Jina", async () => {
    const fetch = vi.fn();
    const result = await registry.run(
      "web",
      "read",
      params,
      context({
        fetch,
        readArticle: async () => {
          throw new ReachChannelError("BAD_INPUT", "private");
        },
      }),
    );
    expect(result.error?.code).toBe("BAD_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the supplied GitHub credential and decodes README", async () => {
    const fetch = vi
      .fn<ReachContext["fetch"]>()
      .mockResolvedValueOnce(response({ full_name: "owner/repo", private: false }))
      .mockResolvedValueOnce(
        response({ content: Buffer.from("# README 中文").toString("base64"), encoding: "base64" }),
      );
    const result = await registry.run(
      "github",
      "read",
      { ...params, target: "https://github.com/owner/repo" },
      context({ fetch, secret: async () => "configured-token" }),
    );
    expect(result.items[0]).toMatchObject({ text: "# README 中文", partial: false });
    expect(fetch.mock.calls[0]?.[1]?.headers?.Authorization).toBe("Bearer configured-token");
  });

  it.each([
    "owner/repo/blob/main/file.ts",
    "owner/..",
    "https://github.com.evil.test/owner/repo",
    "https://user:pass@github.com/owner/repo",
  ])("rejects unsupported GitHub target %s", async (target) => {
    const fetch = vi.fn();
    expect(
      (await registry.run("github", "read", { ...params, target }, context({ fetch }))).error?.code,
    ).toBe("BAD_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not hide README rate limits", async () => {
    const fetch = vi
      .fn<ReachContext["fetch"]>()
      .mockResolvedValueOnce(response({ full_name: "owner/repo", private: false }))
      .mockResolvedValueOnce(response({}, 429));
    expect(
      (
        await registry.run(
          "github",
          "read",
          { ...params, target: "owner/repo" },
          context({ fetch }),
        )
      ).error?.code,
    ).toBe("RATE_LIMITED");
  });

  it("preserves the issue body when comments are rate limited", async () => {
    const fetch = vi
      .fn<ReachContext["fetch"]>()
      .mockResolvedValueOnce(response({ private: false }))
      .mockResolvedValueOnce(response({ title: "Issue", body: "Body", comments: 5 }))
      .mockResolvedValueOnce(response({}, 429));
    const result = await registry.run(
      "github",
      "read",
      { ...params, target: "owner/repo/issues/1" },
      context({ fetch }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RATE_LIMITED");
    expect(result.items[0]?.text).toBe("Body");
  });

  it("marks limited PR discussions and bounds comments including the body", async () => {
    const fetch = vi
      .fn<ReachContext["fetch"]>()
      .mockResolvedValueOnce(response({ private: false }))
      .mockResolvedValueOnce(response({ title: "PR", comments: 5, pull_request: {} }))
      .mockResolvedValueOnce(response([{ body: "comment" }]));
    const result = await registry.run(
      "github",
      "read",
      { target: "owner/repo/pull/1", limit: 2 },
      context({ fetch }),
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.extra).toMatchObject({ kind: "pull_request", commentsTruncated: true });
    expect(result.meta.truncated).toBe(true);
  });

  it("reads V2EX topics and labels incomplete replies", async () => {
    const fetch = vi
      .fn<ReachContext["fetch"]>()
      .mockResolvedValueOnce(response([{ id: 12, title: "主题", content: "正文", replies: 10 }]))
      .mockResolvedValueOnce(response([{ content: "回复" }, { content: "more" }]));
    const result = await registry.run(
      "v2ex",
      "read",
      { target: "https://www.v2ex.com/t/12#reply1", limit: 2 },
      context({ fetch }),
    );
    expect(result.items.map((entry) => entry.text)).toEqual(["正文", "回复"]);
    expect(result.meta.truncated).toBe(true);
  });

  it("does not pretend V2EX supports full-text search", async () => {
    const fetch = vi.fn();
    expect(
      (await registry.run("v2ex", "search", { query: "query", limit: 1 }, context({ fetch }))).error
        ?.code,
    ).toBe("BAD_INPUT");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("excludes private repositories even when a token has access", async () => {
    const fetch = vi.fn<ReachContext["fetch"]>().mockResolvedValue(
      response({
        items: [
          { full_name: "public/repo", private: false },
          { full_name: "private/repo", private: true },
        ],
      }),
    );
    const result = await registry.run(
      "github",
      "search",
      { query: "repo", limit: 10 },
      context({ fetch }),
    );
    expect(result.items.map((entry) => entry.title)).toEqual(["public/repo"]);
    expect(new URL(fetch.mock.calls[0]![0]).searchParams.get("q")).toBe("repo is:public");
  });

  it.each(["owner/repo", "owner/repo/issues/1"])(
    "does not read private GitHub content: %s",
    async (target) => {
      const fetch = vi.fn<ReachContext["fetch"]>().mockResolvedValue(response({ private: true }));
      const result = await registry.run(
        "github",
        "read",
        { ...params, target },
        context({ fetch }),
      );
      expect(result.error?.code).toBe("BAD_INPUT");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
