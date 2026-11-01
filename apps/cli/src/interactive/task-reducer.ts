/**
 * Task/Run 执行树归约逻辑已搬到 `packages/shared/src/task-session.ts`，桌面端工作台
 * 复用同一套实现（`apps/desktop/src/features/code/useRunTree.ts`）。这个文件保留原路径，
 * 整体 re-export，CLI 内部 import 不用跟着改。
 */
export {
  createInitialSession,
  findPendingApproval,
  listRootRuns,
  sessionReducer,
  type TaskAction,
  type TaskSession,
  type TaskSnapshot,
} from "@agentdesk/shared";
