import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { subscribe } from "../lib/http";
import { notify } from "../lib/tauri";

type GlobalEvent =
  | { type: "approval"; approvalId: string }
  | { type: "notification"; title: string; body: string }
  | { type: "feed_updated"; date: string }
  | { type: "deploy_updated"; runId: string; status: string }
  | { type: "workflow_updated"; runId: string; status: string };

/** 订阅 sidecar 全局事件：刷新相关查询缓存，并转成系统通知。 */
export function useGlobalEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    let close = () => {};
    const connect = () => {
      close = subscribe<GlobalEvent>(
        "/events",
        (event) => {
          switch (event.type) {
            case "approval":
              void queryClient.invalidateQueries({ queryKey: ["approvals"] });
              break;
            case "notification":
              void notify(event.title, event.body);
              break;
            case "feed_updated":
              void queryClient.invalidateQueries({ queryKey: ["feed"] });
              break;
            case "deploy_updated":
              void queryClient.invalidateQueries({ queryKey: ["deploy-runs"] });
              break;
            case "workflow_updated":
              void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
              break;
          }
        },
        {
          onError: () => {
            close();
            retry = setTimeout(connect, 3000);
          },
        },
      );
    };
    connect();
    return () => {
      clearTimeout(retry);
      close();
    };
  }, [queryClient]);
}
