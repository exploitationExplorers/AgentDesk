import { useCallback, useEffect, useRef, useState } from "react";
import type { Approval } from "@agentdesk/shared";
import { apiRequest as defaultApiRequest, type ApiState } from "../client.js";

interface ApprovalDecision {
  approved: boolean;
  source: "local" | "remote";
}

interface ApprovalWaiter {
  id: string;
  finish: (decision: ApprovalDecision | null) => void;
}

/** 终端与工作台共用审批状态；远端已决定的审批只同步显示，不重复提交。 */
export function useApprovalWaiter(state: ApiState, apiRequest = defaultApiRequest) {
  const waiterRef = useRef<ApprovalWaiter | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const waitForApproval = useCallback((id: string, signal: AbortSignal) => {
    waiterRef.current?.finish(null);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise<ApprovalDecision | null>((resolve) => {
      const abort = () => waiter.finish(null);
      const waiter: ApprovalWaiter = {
        id,
        finish: (decision) => {
          signal.removeEventListener("abort", abort);
          if (waiterRef.current !== waiter) return;
          waiterRef.current = null;
          resolve(decision);
        },
      };
      waiterRef.current = waiter;
      signal.addEventListener("abort", abort, { once: true });
    });
  }, []);

  const answerLocally = useCallback((approved: boolean) => {
    waiterRef.current?.finish({ approved, source: "local" });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const options = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) };
        const pending = await (
          await apiRequest<Approval[]>(state, "/approvals?status=pending", options)
        ).json();
        if (controller.signal.aborted) return;
        setPendingCount(pending.length);
        const waiter = waiterRef.current;
        if (waiter && !pending.some((approval) => approval.id === waiter.id)) {
          const all = await (await apiRequest<Approval[]>(state, "/approvals", options)).json();
          const resolved = all.find(
            (approval) => approval.id === waiter.id && approval.status !== "pending",
          );
          if (!controller.signal.aborted && resolved && waiterRef.current === waiter) {
            waiter.finish({ approved: resolved.status === "approved", source: "remote" });
          }
        }
      } catch {
        // 临时网络故障不影响本地操作，下一次轮询继续同步。
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      clearInterval(timer);
      controller.abort();
      waiterRef.current?.finish(null);
    };
  }, [state, apiRequest]);

  return { pendingCount, waitForApproval, answerLocally };
}
