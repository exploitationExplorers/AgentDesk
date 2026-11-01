import { useMemo } from "react";
import { createInitialSession, sessionReducer, type RunEventRecord } from "@agentdesk/shared";

/** 把 RunEventRecord[] 归约成真正的 Run 树（父子委派关系），给「流程图」标签用；
 * 和 CLI 共用 packages/shared/src/task-session.ts 的同一套归约逻辑。 */
export function useRunTree(records: RunEventRecord[]) {
  return useMemo(() => records.reduce(sessionReducer, createInitialSession()), [records]);
}
