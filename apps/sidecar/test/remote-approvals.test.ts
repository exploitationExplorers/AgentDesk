import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EventHub } from "../src/events";
import { ApprovalService } from "../src/services/approvals";
import { RemoteApprovalService } from "../src/services/remote/approvals";
import { RemoteOperationStore } from "../src/services/remote/operations";

let handle: DbHandle;
let approvals: ApprovalService;
let remote: RemoteApprovalService;
const scope = { userId: "owner", hostId: "cloud", projectId: "p1", workspaceId: "w1" };
const decision = {
  clientRequestId: "request-approve",
  version: 1,
  actionDigest: "a".repeat(64),
  approved: true,
};
beforeEach(() => {
  handle = openDatabase(":memory:");
  approvals = new ApprovalService(handle.db, new EventHub());
  remote = new RemoteApprovalService(handle.raw, approvals);
});
afterEach(() => handle.close());
function create(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  const { operation } = new RemoteOperationStore(handle.raw).accept(
    scope,
    "git.commit",
    "request-1",
    {},
  );
  const approval = approvals.create({
    kind: "tool",
    title: "Commit",
    detail: "Only a.ts",
    risk: "confirm",
    payload: {},
  });
  remote.attach({
    ...scope,
    approvalId: approval.approval.id,
    operationId: operation.operationId,
    taskId: null,
    action: "git.commit",
    actionDigest: decision.actionDigest,
    version: 1,
    expiresAt,
    resolvedBy: null,
    decision: null,
  });
  return approval;
}
describe("远程审批绑定", () => {
  it("同决定返回已有结果，相反决定冲突，唤醒真实等待方", async () => {
    const { approval, wait } = create();
    expect(remote.resolve(scope, approval.id, decision).approval.status).toBe("approved");
    expect(await wait()).toBe(true);
    expect(remote.resolve(scope, approval.id, decision).context.resolvedBy).toBe(scope.userId);
    expect(() => remote.resolve(scope, approval.id, { ...decision, approved: false })).toThrow(
      /相反/,
    );
  });
  it("错误项目／工作区、版本、动作摘要均不能批准", () => {
    const { approval } = create();
    for (const field of ["userId", "hostId", "projectId", "workspaceId"] as const)
      expect(() => remote.resolve({ ...scope, [field]: "other" }, approval.id, decision)).toThrow(
        /不存在/,
      );
    expect(() => remote.resolve(scope, approval.id, { ...decision, version: 2 })).toThrow(/版本/);
    expect(() =>
      remote.resolve(scope, approval.id, { ...decision, actionDigest: "b".repeat(64) }),
    ).toThrow(/摘要/);
    expect(approvals.get(approval.id)?.status).toBe("pending");
  });
  it("过期审批和重启后原等待方失效都拒绝", () => {
    const { approval } = create(new Date(Date.now() - 1).toISOString());
    expect(() => remote.resolve(scope, approval.id, decision)).toThrow(/过期/);
    const restarted = new ApprovalService(handle.db, new EventHub());
    const service = new RemoteApprovalService(handle.raw, restarted);
    expect(() => service.resolve(scope, approval.id, decision)).toThrow(/过期/);
  });
  it("本地已拒绝的审批不能被远程改为批准", () => {
    const { approval } = create();
    approvals.resolve(approval.id, false);
    expect(() => remote.resolve(scope, approval.id, decision)).toThrow(/其他入口/);
    expect(remote.get(scope, approval.id)?.decision).toBeNull();
  });
});
