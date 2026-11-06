import { hubFactSchema, type HubFact } from "./protocol";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 按 SSE 行边界组帧，保留跨网络分片的 CRLF 和 UTF-8 字符。 */
export async function* readHubFacts(response: Response): AsyncGenerator<HubFact> {
  if (!response.body) throw new Error("Hub 事实流缺少正文");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let frameBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r\n|\r|\n/.exec(buffer))) {
        // 最后一字节可能是 CRLF 的前半段，下一次读取再决定。
        if (!done && boundary[0] === "\r" && boundary.index === buffer.length - 1) break;
        const line = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        frameBytes += Buffer.byteLength(line) + boundary[0].length;
        if (frameBytes > MAX_FRAME_BYTES) throw new Error("Hub 事实帧过大");
        if (line === "") {
          if (data.length > 0 && (!event || event === "fact"))
            yield hubFactSchema.parse(JSON.parse(data.join("\n")));
          data = [];
          event = "";
          frameBytes = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const content = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(content);
          if (field === "event") event = content;
        }
      }
      if (frameBytes + Buffer.byteLength(buffer) > MAX_FRAME_BYTES)
        throw new Error("Hub 事实帧过大");
      // 未以空行终止的尾帧不能推进游标，重连时由 after 重新读取。
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
