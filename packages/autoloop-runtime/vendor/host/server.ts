// What the kernel's doors need from this machine: the clock, a timer for the next deadline, long polls to wake, the
// rules file to watch, the log as a stream and the webhook plugins.
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { RULES_FILE } from "./home.ts";
import { loadPlugin } from "./plugins.ts";
import * as hub from "./runtime.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import { createHandler } from "../kernel/http.ts";

/** Past this setTimeout fires at once. */
const LONGEST_TIMER = 2147483647;
const TICK_RETRY = 5_000;

function logStream(after: number, signal: AbortSignal, key: string) {
  let cursor = after;
  let unsubscribe = () => {};
  let stop = () => {};
  const detach = () => {
    unsubscribe();
    signal.removeEventListener("abort", stop);
  };
  let send = () => {};
  let stopped = false;
  return new ReadableStream({
    start(controller) {
      stop = () => {
        if (stopped) return;
        stopped = true;
        detach();
        controller.close();
      };
      send = () => {
        if (stopped) return;
        if (!hub.whose("owner", key)) return stop();
        if (controller.desiredSize! <= 0) return;
        for (const fact of hub.logAfter(cursor, 1)) {
          cursor = fact.seq;
          const message = `id: ${fact.seq}\nevent: fact\ndata: ${JSON.stringify(fact)}\n\n`;
          controller.enqueue(new TextEncoder().encode(message));
        }
      };
      unsubscribe = hub.onChange(send);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    },
    pull() {
      send();
    },
    cancel() {
      stopped = true;
      detach();
    },
  });
}

async function adaptWebhook(source: string, headers: Headers, body: string) {
  const adapter = hub.rules.sources[source]?.adapter;
  if (!adapter || !/^[a-z][a-z0-9-]*$/.test(adapter)) throw new NotFound("这个来源不收 Webhook");
  const translate = await loadPlugin(adapter, "source");
  const secret = process.env[`AGENT_AUTOLOOP_SECRET_${source.toUpperCase().replaceAll("-", "_")}`] ?? "";
  try {
    const events = translate({ headers: Object.fromEntries(headers), body, secret });
    return Array.isArray(events) ? events : [];
  } catch {
    throw new AuthError("验签没过");
  }
}

export function makeHandler(commit = "dev") {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let retryAt: number | undefined;
  const waiting = new Set<{ until: number; done: () => void }>();
  const wake = () => {
    for (const waiter of [...waiting]) waiter.done();
  };
  const fire = () => {
    try {
      hub.tick();
      retryAt = undefined;
    } catch (error) {
      // Another process holding the database too long, say. Nobody is there to catch it, and what it brought is still due.
      console.error(error);
      retryAt = Date.now() + TICK_RETRY;
    }
    wake();
    arm();
  };
  const arm = () => {
    clearTimeout(timer);
    if (closed) return;
    const due = hub.one<{ at: number }>(
      "SELECT MIN(json_extract(data, '$.at')) AS at FROM projections WHERE collection='due'",
    );
    // Whatever the failed tick left is overdue, so it would go at once; and nothing else coming along may lose the retry.
    const next = retryAt ?? Math.min(due?.at ?? Infinity, ...[...waiting].map((waiter) => waiter.until));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(fire, Math.max(0, Math.min(LONGEST_TIMER, next - Date.now())));
  };
  const unlisten = hub.onChange((type, facts) => {
    // Being seen wakes nobody, unless it changed a card.
    const justSeen = type === "heartbeat" || type === "channelSeen";
    if (!justSeen || facts.some((fact) => fact.changes.some((change) => change.table === "cards"))) wake();
    arm();
  });
  const watcher = watch(dirname(RULES_FILE), (_event, file) => {
    if (file === basename(RULES_FILE) || file === null) fire();
  });
  const handle = createHandler({
    commit,
    now: Date.now,
    view: hub.getView,
    environment: hub.environment,
    dispatch: hub.execute,
    state: hub.stateOf,
    why: hub.why,
    card: hub.cardByToken,
    wait(until, signal) {
      return new Promise((resolve) => {
        const waiter = {
          until,
          done() {
            waiting.delete(waiter);
            signal.removeEventListener("abort", waiter.done);
            resolve();
          },
        };
        waiting.add(waiter);
        signal.addEventListener("abort", waiter.done, { once: true });
        if (signal.aborted) waiter.done();
        arm();
      });
    },
    stream: logStream,
    adapt: adaptWebhook,
  });
  fire();
  return {
    handle,
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
      unlisten();
      wake();
    },
  };
}
