import type { AgentStreamEvent } from "@agentdesk/shared";
import type { CliState } from "./state.js";

export type ApiState = Pick<CliState, "port" | "token">;
export interface InstanceInfo {
  instanceId: string;
  pid: number;
  version: string;
  mode: CliState["mode"];
  dataDir: string;
}
export type ApiResponse<T> = Omit<Response, "json"> & { json(): Promise<T> };

export async function apiRequest<T = unknown>(
  state: ApiState,
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  if (!state.port) throw new Error("服务仍在启动，请稍后重试。");
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("X-AgentDesk-Token", state.token);
  const response = await fetch(`http://127.0.0.1:${state.port}/api${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
    const message =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : `请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return response as ApiResponse<T>;
}

export async function verifyInstance(state: CliState) {
  const response = await apiRequest<InstanceInfo>(state, "/cli/instance", {
    signal: AbortSignal.timeout(1_500),
  });
  const actual = await response.json();
  if (actual.instanceId !== state.instanceId || actual.pid !== state.pid) {
    throw new Error("端口上的服务与本地实例记录不符，已拒绝操作。");
  }
  return actual;
}

/** 支持跨网络分片、UTF-8、多行 data 和 CRLF；回调可暂停以处理交互审批。 */
export async function consumeSse<T = AgentStreamEvent>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void | Promise<void>,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = async (record: string) => {
    const data = record
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) await onEvent(JSON.parse(data));
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        await dispatch(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
    }
    if (buffer.trim()) await dispatch(buffer);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
