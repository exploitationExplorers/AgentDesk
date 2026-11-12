import { expect, it } from "vitest";
import { GatewayEvents } from "../src/remote/events";
import type { RunnerClient } from "../src/remote/client";
import type { RemoteRoutingStore } from "../src/remote/store";

it.each([false, true])(
  "shutdown closes upstream subscriptions even without a consumer read: %s",
  async (reading) => {
    let cancelled = false;
    const events = new GatewayEvents(
      {
        grant: async () => {},
        command: () => ({}),
        request: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      } as unknown as RunnerClient,
      { sessionAlive: async () => true } as unknown as RemoteRoutingStore,
    );
    const stream = await events.open(
      { userId: "owner", sessionId: "session", recentAuthAt: new Date().toISOString() },
      { userId: "owner", hostId: "cloud", projectId: "project", workspaceId: "project" },
      "task",
      0,
      new AbortController().signal,
    );
    const reader = stream.getReader();
    const pending = reading ? reader.read() : undefined;
    events.closeAll();
    expect(await (pending ?? reader.read())).toEqual({ done: true, value: undefined });
    expect(cancelled).toBe(true);
    events.closeAll();
  },
);
