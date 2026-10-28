import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventHub } from "../events";
import type { RunEventRecord, TaskService } from "../services/tasks";

/**
 * Task/Run 频道不调用 hub.retain()：内存缓冲只能回放"进程存活期间"的事件，
 * 而断线补齐需要跨越任意长的离线窗口，必须以 run_events 表的自增 seq 为准直接查库；
 * 对这类频道启用 retain 只会维护一份多余且仍然有限的过时缓冲。
 */

type QueueItem = RunEventRecord | { type: "ping" };

function isPing(item: QueueItem): item is { type: "ping" } {
  return "type" in item && item.type === "ping";
}

/** 把 Task/Run 事件频道转成带序号断线重连的 SSE：先订阅，再补齐历史，再排空订阅期间的缓冲，然后持续监听。 */
export function taskChannelToSse(
  c: Context,
  hub: EventHub,
  tasks: TaskService,
  channel: string,
  filter: { taskId?: string; runId?: string },
  initialAfter: number,
  isTerminal: (record: RunEventRecord) => boolean,
) {
  return streamSSE(c, async (stream) => {
    let closed = false;
    const queue: QueueItem[] = [];
    let wake: (() => void) | null = null;
    const push = (item: QueueItem) => {
      queue.push(item);
      wake?.();
    };

    // 1) 先订阅，此时还未向 SSE 流写任何东西，避免漏掉订阅与补历史之间产生的事件
    const unsubscribe = hub.subscribe(channel, (event) => push(event as RunEventRecord));
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });

    let lastSentSeq = initialAfter;
    let lastWritten: RunEventRecord | null = null;
    const writeRecord = async (record: RunEventRecord) => {
      await stream.writeSSE({ data: JSON.stringify(record) });
      lastSentSeq = record.seq;
      lastWritten = record;
    };

    // 2) 查库补齐历史事件。任务级订阅下历史里可能混有更早、早已终止的根 Run（例如 resume
    // 之前的那一轮），这类旧记录不能用来判定"该不该收尾"——只有补齐完之后最新的那一条才代表
    // 当前订阅是否已经没有更多事情可做。
    for (const record of tasks.eventsAfter({ ...filter, after: initialAfter, limit: 500 })) {
      await writeRecord(record);
    }

    // 3) 排空订阅期间攒下的队列，按 seq 去重
    const buffered = queue.splice(0, queue.length);
    for (const item of buffered) {
      if (isPing(item)) continue;
      if (item.seq <= lastSentSeq) continue;
      await writeRecord(item);
    }

    // 4) 如果订阅的 Run/Task 在连接建立前就已经跑完（例如 resume 同步等待创建请求返回之后才
    // 打开流，这期间 Run 可能已经真正执行完毕），此时历史补齐 + 排空缓冲里最新的一条就已经是
    // 终止事件，必须立即收尾；否则会一直挂到下一次心跳才收到一条孤立的 ping，连接无限挂起
    // （不会再有任何新事件触发下面"持续监听"循环里的终止判断）。
    if (lastWritten && isTerminal(lastWritten)) {
      unsubscribe();
      return;
    }

    // 5) 心跳：推入同一队列以和真实事件串行写入流
    const heartbeat = setInterval(() => push({ type: "ping" }), 15_000);
    try {
      // 6) 持续监听后续事件
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        const item = queue.shift()!;
        if (isPing(item)) {
          await stream.writeSSE({ data: JSON.stringify(item) });
          continue;
        }
        if (item.seq <= lastSentSeq) continue;
        await writeRecord(item);
        // 7) 终止条件：run_ended 命中订阅的 run，或任务级订阅命中根 Run 的 run_ended
        if (isTerminal(item)) break;
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
}
