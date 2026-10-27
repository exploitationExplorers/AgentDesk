export async function apiRequest(state, path, options = {}) {
  if (!state.port) throw new Error("服务仍在启动，请稍后重试。");
  const response = await fetch(`http://127.0.0.1:${state.port}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-AgentDesk-Token": state.token,
      ...options.headers,
    },
    signal: options.signal ?? AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
  }
  return response;
}

export async function verifyInstance(state) {
  const response = await apiRequest(state, "/cli/instance", { signal: AbortSignal.timeout(1_500) });
  const actual = await response.json();
  if (actual.instanceId !== state.instanceId || actual.pid !== state.pid) {
    throw new Error("端口上的服务与本地实例记录不符，已拒绝操作。");
  }
  return actual;
}

/** 支持跨网络分片、UTF-8、多行 data 和 CRLF；回调可暂停以处理交互审批。 */
export async function consumeSse(body, onEvent) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const dispatch = async (record) => {
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
      if (done) break;
      buffer += value;
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
