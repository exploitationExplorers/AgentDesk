import { z } from "zod";
import {
  AUTOLOOP_COMMIT,
  hubEventSchema,
  hubEventAckSchema,
  hubWorkSchema,
  hubReceiptSchema,
  hubCardStateSchema,
  type HubCard,
  type HubEvent,
  type HubFact,
} from "./protocol";
import { readHubFacts } from "./fact-stream";

export class AutoloopClientError extends Error {
  constructor(readonly status: number) {
    super(`Autoloop Hub 请求失败（HTTP ${status}）`);
    this.name = "AutoloopClientError";
  }
}
export interface AutoloopClientOptions {
  baseUrl: string;
  credentials: { owner: string; worker: string; source: string };
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}
export function validateAutoloopBaseUrl(value: string): URL {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Hub 地址必须是无凭据、参数和路径的本机 HTTP 或远程 HTTPS 地址");
  return url;
}
const MAX_BYTES = 4 * 1024 * 1024;
const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const credentialSchema = z
  .string()
  .min(1)
  .regex(/^[\x21-\x7e]+$/);
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Hub 响应过大");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class AutoloopClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: AutoloopClientOptions) {
    this.baseUrl = validateAutoloopBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    for (const credential of Object.values(options.credentials)) credentialSchema.parse(credential);
    if (options.timeoutMs !== undefined)
      z.number().int().positive().max(2_147_483_647).parse(options.timeoutMs);
  }
  async health(): Promise<void> {
    const health = z.object({ ok: z.literal(true), commit: z.literal(AUTOLOOP_COMMIT) });
    health.parse(await this.request("/healthz", this.options.credentials.owner));
  }
  postEvent(event: HubEvent) {
    return this.sendEvent(JSON.stringify(hubEventSchema.parse(event)));
  }
  async sendEvent(serializedBody: string) {
    return hubEventAckSchema.parse(
      await this.request("/v1/events", this.options.credentials.source, serializedBody),
    );
  }
  async work(claim: string, capacity: 0 | 1, running: number[] = [], signal?: AbortSignal) {
    z.string().min(1).max(200).parse(claim);
    z.union([z.literal(0), z.literal(1)]).parse(capacity);
    z.array(positiveId).parse(running);
    const query = new URLSearchParams({
      claim,
      capacity: String(capacity),
      running: running.join(","),
      wait: "0",
    });
    return hubWorkSchema.parse(
      await this.request(`/v1/work?${query}`, this.options.credentials.worker, undefined, signal),
    );
  }
  async started(runId: number, token: string, session: string) {
    positiveId.parse(runId);
    z.string().max(500).parse(session);
    await this.request(`/v1/runs/${runId}/started`, token, JSON.stringify({ session }));
  }
  async result(runId: number, token: string, serializedBody: string) {
    positiveId.parse(runId);
    return hubReceiptSchema.parse(
      await this.request(`/v1/runs/${runId}/result`, token, serializedBody),
    );
  }
  async cancelRun(runId: number) {
    positiveId.parse(runId);
    await this.request(`/v1/runs/${runId}/cancel`, this.options.credentials.owner, "{}");
  }
  async answerCard(cardId: number, serializedBody: string) {
    positiveId.parse(cardId);
    return z
      .object({ changed: z.boolean(), state: z.string() })
      .parse(
        await this.request(
          `/v1/cards/${cardId}/answer`,
          this.options.credentials.owner,
          serializedBody,
        ),
      );
  }
  async state() {
    return this.request("/v1/state", this.options.credentials.owner);
  }

  /** 上游只返回全部未答卡片及最近 20 张已处理卡片；null 表示无法对账。 */
  async getCard(cardId: number): Promise<HubCard | null> {
    positiveId.parse(cardId);
    const state = hubCardStateSchema.parse(await this.state());
    return [...state.cards, ...state.recentCards].find((card) => card.id === cardId) ?? null;
  }

  /** 固定上游版本只能关闭 open 卡片，decided/done/closed 返回 changed:false。 */
  async resolveCard(cardId: number, reason: string): Promise<{ changed: boolean }> {
    positiveId.parse(cardId);
    z.string()
      .max(1000)
      .refine((value) => value.trim().length > 0)
      .parse(reason);
    return z
      .object({ changed: z.boolean() })
      .parse(
        await this.request(
          `/v1/cards/${cardId}/resolve`,
          this.options.credentials.owner,
          JSON.stringify({ reason }),
        ),
      );
  }

  /** 事实只交给后端投影；有界帧避免断线或畸形流无限积累。 */
  async *facts(after: number, signal: AbortSignal): AsyncGenerator<HubFact> {
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(after);
    const response = await this.fetchImpl(new URL(`/v1/stream?after=${after}`, this.baseUrl), {
      headers: { Authorization: `Bearer ${this.options.credentials.owner}` },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AutoloopClientError(response.status);
    }
    yield* readHubFacts(response);
  }
  private async request(
    path: string,
    token: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    credentialSchema.parse(token);
    if (body !== undefined && Buffer.byteLength(body) > 1024 * 1024)
      throw new Error("Hub 请求正文过大");
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AutoloopClientError(response.status);
    }
    return JSON.parse(await boundedText(response)) as unknown;
  }
}
