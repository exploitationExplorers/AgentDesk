import type {
  Approval,
  RemoteApprovalContext,
  Run,
  RunEventRecord,
  Task,
  Provider,
} from "@agentdesk/shared";

export interface CloudSession {
  user: { id: string; email: string; role: string };
  session: { id: string; expiresAt: string; recentAuthAt: string };
  csrfToken: string;
}
export interface CloudHost {
  id: string;
  name: string;
  kind: "cloud" | "office";
  status: string;
  lastSeen?: string | null;
  capabilities: string[];
}
export interface CloudProject {
  id: string;
  name: string;
  workspaceId: string;
  branch?: string;
}
export interface CloudApproval {
  approval: Approval;
  context: RemoteApprovalContext;
}
export interface CloudTaskSnapshot {
  task: Task;
  runs: Run[];
  run?: Run;
  approvals: CloudApproval[];
}
export interface CloudExecutor {
  id: "native-bot" | "codex";
  available: boolean;
  reason?: string;
}
export type CloudProvider = Provider;

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const cloudPath = (...parts: string[]) =>
  `/api/v1/${parts.map(encodeURIComponent).join("/")}`;
export const requestId = () => crypto.randomUUID();

/** Cookie 和敏感状态仅存内存；跨宿主或会话失效时取消所有在途请求。 */
export class CloudApi {
  private csrf = "";
  private generation = 0;
  private requests = new Set<AbortController>();
  onUnauthorized: () => void = () => {};

  setCsrf(token: string) {
    this.csrf = token;
  }
  clear() {
    this.csrf = "";
    this.cancelPending();
  }
  cancelPending() {
    this.generation++;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }
  async request<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    signal?: AbortSignal,
  ): Promise<T> {
    if (!path.startsWith("/api/v1/")) throw new Error("Invalid cloud API path");
    if (!["GET", "HEAD"].includes(method) && !navigator.onLine)
      throw new CloudApiError(503, "OFFLINE", "当前离线，写操作未发送。连接恢复后请先刷新状态。");
    const epoch = this.generation;
    const controller = new AbortController();
    this.requests.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(body !== undefined
            ? { "Content-Type": "application/json", "X-CSRF-Token": this.csrf }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (epoch !== this.generation) throw new DOMException("Request superseded", "AbortError");
      await this.check(response);
      const value: unknown = response.status === 204 ? undefined : await response.json();
      if (epoch !== this.generation) throw new DOMException("Request superseded", "AbortError");
      return value as T;
    } finally {
      this.requests.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
  async session(signal?: AbortSignal) {
    const session = await this.request<CloudSession>("/api/v1/session", undefined, "GET", signal);
    this.csrf = session.csrfToken;
    return session;
  }
  async loginCsrf() {
    const result = await this.request<{ csrfToken: string }>("/api/v1/auth/csrf");
    this.csrf = result.csrfToken;
  }
  private async check(response: Response) {
    if (response.ok) return;
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      /* 代理错误未必是 JSON。 */
    }
    if (response.status === 401) {
      this.clear();
      this.onUnauthorized();
    }
    throw new CloudApiError(
      response.status,
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.message ??
        {
          401: "登录已过期，请重新登录",
          403: "当前操作没有权限，请刷新后重试",
          404: "当前宿主尚未提供此功能",
          409: "状态已变化，请刷新后重新确认",
          429: "操作太频繁，请稍后再试",
          503: "宿主暂时不可用，请稍后重试",
        }[response.status] ??
        "服务暂时无法完成请求",
    );
  }

  /** fetch 流可识别 401；游标仅在完整消息校验后前移，重连不会重复渲染。 */
  watchTask(
    hostId: string,
    taskId: string,
    onRecord: (record: RunEventRecord) => void,
    onState: (state: "connected" | "reconnecting" | "history_expired") => void,
  ): () => void {
    const controller = new AbortController();
    this.requests.add(controller);
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const response = await fetch(
          `${cloudPath("hosts", hostId, "tasks", taskId, "events")}?after=${cursor}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            headers: { Accept: "text/event-stream", "Last-Event-ID": String(cursor) },
            signal: controller.signal,
          },
        );
        await this.check(response);
        if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
          throw new Error("Invalid event stream");
        onState("connected");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let pending = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += value.replace(/\r\n/g, "\n");
            if (pending.length > 1024 * 1024) throw new Error("Event exceeds size limit");
            let end: number;
            while ((end = pending.indexOf("\n\n")) !== -1) {
              const block = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (!data) continue;
              if (block.split("\n").some((line) => line.trim() === "event: history_expired")) {
                controller.abort();
                onState("history_expired");
                return;
              }
              const record = JSON.parse(data) as Partial<RunEventRecord>;
              if (
                typeof record.seq !== "number" ||
                !Number.isSafeInteger(record.seq) ||
                record.seq <= cursor ||
                record.taskId !== taskId ||
                !record.event
              )
                continue;
              onRecord(record as RunEventRecord);
              cursor = record.seq;
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      } catch (error) {
        if (controller.signal.aborted || (error instanceof CloudApiError && error.status === 401))
          return;
      }
      if (!controller.signal.aborted) {
        onState("reconnecting");
        timer = setTimeout(() => void connect(), 3000);
      }
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
      this.requests.delete(controller);
    };
  }
}

export function errorMessage(error: unknown) {
  if (error instanceof CloudApiError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return "连接中断，请检查网络后重试。尚未确认的操作请先查看最新状态。";
}
