import { AppError, ErrorCode, type Approval, type RiskLevel } from "@agentdesk/shared";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { GLOBAL_CHANNEL, type EventHub, type GlobalEvent } from "../events";
import { newId, nowIso } from "../util";

export interface ApprovalDraft {
  kind: Approval["kind"];
  title: string;
  detail: string;
  risk: RiskLevel;
  payload: unknown;
}

/** ActionDraft 审批中心：所有危险操作先落库，等待用户在 UI 上确认。 */
export class ApprovalService {
  private readonly store: Collection<Approval>;
  private readonly waiters = new Map<string, (approved: boolean) => void>();

  constructor(
    db: Db,
    private readonly hub: EventHub,
  ) {
    this.store = new Collection<Approval>(db, "approvals");
    // 进程重启后，之前未决的审批已没有等待方
    for (const a of this.store.list()) {
      if (a.status === "pending") this.store.put({ ...a, status: "expired", resolvedAt: nowIso() });
    }
  }

  list(status?: Approval["status"]): Approval[] {
    const all = this.store.list();
    return status ? all.filter((a) => a.status === status) : all.slice(0, 100);
  }

  create(draft: ApprovalDraft): {
    approval: Approval;
    wait: (signal?: AbortSignal) => Promise<boolean>;
  } {
    const approval: Approval = {
      id: newId(),
      ...draft,
      status: "pending",
      createdAt: nowIso(),
      resolvedAt: null,
    };
    this.store.put(approval);
    const promise = new Promise<boolean>((resolve) => this.waiters.set(approval.id, resolve));
    this.hub.publish(GLOBAL_CHANNEL, {
      type: "approval",
      approvalId: approval.id,
    } satisfies GlobalEvent);
    return {
      approval,
      wait: (signal) => {
        signal?.addEventListener("abort", () => this.resolve(approval.id, false, "expired"));
        return promise;
      },
    };
  }

  /** 创建并等待，便于工具调用直接 await */
  async request(
    draft: ApprovalDraft,
    signal?: AbortSignal,
    onCreated?: (a: Approval) => void,
  ): Promise<boolean> {
    const { approval, wait } = this.create(draft);
    onCreated?.(approval);
    return wait(signal);
  }

  resolve(id: string, approved: boolean, status?: Approval["status"]): Approval {
    const approval = this.store.get(id);
    if (!approval) throw new AppError(ErrorCode.NotFound, "审批不存在");
    if (approval.status !== "pending") return approval;
    const next = this.store.put({
      ...approval,
      status: status ?? (approved ? "approved" : "rejected"),
      resolvedAt: nowIso(),
    });
    this.waiters.get(id)?.(approved);
    this.waiters.delete(id);
    this.hub.publish(GLOBAL_CHANNEL, { type: "approval", approvalId: id } satisfies GlobalEvent);
    return next;
  }
}
