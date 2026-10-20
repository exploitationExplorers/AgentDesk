import type { ApiErrorBody } from "@agentdesk/shared";
import { getSidecarInfo, type SidecarInfo } from "./tauri";

let infoPromise: Promise<SidecarInfo> | null = null;
const info = () => (infoPromise ??= getSidecarInfo());

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function apiUrl(
  path: string,
  query?: Record<string, string | undefined>,
): Promise<string> {
  const { url, token } = await info();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== "") params.set(k, v);
  if (token) params.set("token", token);
  const qs = params.toString();
  return `${url}/api${path}${qs ? `?${qs}` : ""}`;
}

async function headers(): Promise<Record<string, string>> {
  const { token } = await info();
  return { "Content-Type": "application/json", ...(token ? { "X-AgentDesk-Token": token } : {}) };
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const { url } = await info();
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== "") params.set(k, v);
  const qs = params.toString();
  const response = await fetch(`${url}/api${path}${qs ? `?${qs}` : ""}`, {
    method,
    headers: await headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      response.status,
      err?.code ?? "HTTP_ERROR",
      err?.message ?? `请求失败（${response.status}）`,
      err?.details,
    );
  }
  return data as T;
}

export const http = {
  get: <T>(path: string, query?: Record<string, string | undefined>) =>
    request<T>("GET", path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
};

/** POST 请求的 SSE 流（EventSource 只支持 GET） */
export async function postStream<E>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { url } = await info();
  const response = await fetch(`${url}/api${path}`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      data?.error.code ?? "HTTP_ERROR",
      data?.error.message ?? "请求失败",
    );
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as E);
    }
  }
}

/**
 * GET SSE，返回关闭函数。
 * 运行类事件流在结束后会被服务端关闭，EventSource 默认会自动重连并重放缓冲区，
 * 因此调用方应通过 isFinal 声明终止事件，收到后主动关闭。
 */
export function subscribe<E>(
  path: string,
  onEvent: (event: E) => void,
  options: { onError?: () => void; isFinal?: (event: E) => boolean } = {},
): () => void {
  let source: EventSource | null = null;
  let closed = false;
  void apiUrl(path).then((u) => {
    if (closed) return;
    source = new EventSource(u);
    source.onmessage = (e) => {
      const data = JSON.parse(e.data) as E & { type?: string };
      if (data.type === "ping") return;
      onEvent(data);
      if (options.isFinal?.(data)) {
        closed = true;
        source?.close();
      }
    };
    source.onerror = () => options.onError?.();
  });
  return () => {
    closed = true;
    source?.close();
  };
}
