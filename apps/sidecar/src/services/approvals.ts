import {
  AppError,
  ErrorCode,
  type Approval,
  type ApprovalReason,
  type RiskLevel,
} from "@agentdesk/shared";
import type { Db } from "../db/client";
import { businessDatabase, type BusinessDatabase } from "../db/business-database";
import type Database from "better-sqlite3";
import { GLOBAL_CHANNEL, type EventHub, type GlobalEvent } from "../events";
import { newId, nowIso } from "../util";
import { sqliteDocuments } from "./storage/async-documents";
import type { AsyncDocumentRepository } from "./storage/async-ports";
export interface ApprovalDraft {
  conversationId?: string;
  kind: Approval["kind"];
  title: string;
  detail: string;
  risk: RiskLevel;
  payload: unknown;
  reason?: ApprovalReason;
}
/** 审批与回答先提交业务库，再通知界面并唤醒执行者。 */
export class ApprovalService {
  readonly ready: Promise<void>;
  private readonly store: AsyncDocumentRepository<Approval>;
  private readonly business: BusinessDatabase;
  private readonly waiters = new Map<string, (approved: boolean) => void>();
  constructor(
    db: Db,
    private readonly hub: EventHub,
    options?: {
      store: AsyncDocumentRepository<Approval>;
      business: BusinessDatabase;
    },
  ) {
    this.store = options?.store ?? sqliteDocuments(db, "approvals");
    this.business =
      options?.business ??
      businessDatabase(
        (
          db as Db & {
            $client: Database.Database;
          }
        ).$client,
      );
    this.ready = this.business
      .transaction(async () => {
        for (const approval of await this.store.list()) {
          if (approval.status === "pending")
            await this.store.put({ ...approval, status: "expired", resolvedAt: nowIso() });
        }
      })
      .immediate();
  }
  async list(status?: Approval["status"]): Promise<Approval[]> {
    await this.ready;
    const all = await this.store.list();
    return status ? all.filter((value) => value.status === status) : all.slice(0, 100);
  }
  async get(id: string): Promise<Approval | undefined> {
    await this.ready;
    return this.store.get(id);
  }
  async create(draft: ApprovalDraft): Promise<{
    approval: Approval;
    wait: (signal?: AbortSignal) => Promise<boolean>;
  }> {
    await this.ready;
    const approval: Approval = {
      id: newId(),
      ...draft,
      status: "pending",
      createdAt: nowIso(),
      resolvedAt: null,
    };
    await this.store.put(approval);
    const promise = new Promise<boolean>((resolve) => this.waiters.set(approval.id, resolve));
    this.business.afterCommit(() =>
      this.hub.publish(GLOBAL_CHANNEL, {
        type: "approval",
        approvalId: approval.id,
      } satisfies GlobalEvent),
    );
    return {
      approval,
      wait: async (signal) => {
        const abort = async () => {
          void this.resolve(approval.id, false, "expired").catch(() => {
            this.waiters.get(approval.id)?.(false);
            this.waiters.delete(approval.id);
            console.error("[approvals] Failed to persist cancellation");
          });
        };
        if (signal?.aborted) await abort();
        else signal?.addEventListener("abort", abort, { once: true });
        try {
          return await promise;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
    };
  }
  async request(
    draft: ApprovalDraft,
    signal?: AbortSignal,
    onCreated?: (approval: Approval) => void | Promise<unknown>,
  ): Promise<boolean> {
    const { approval, wait } = await this.create(draft);
    try {
      await onCreated?.(approval);
    } catch (error) {
      await this.resolve(approval.id, false, "expired");
      throw error;
    }
    return wait(signal);
  }
  async resolve(id: string, approved: boolean, status?: Approval["status"]): Promise<Approval> {
    await this.ready;
    return this.business
      .transaction(async () => {
        const approval = await this.store.get(id);
        if (!approval) throw new AppError(ErrorCode.NotFound, "审批不存在");
        if (approval.status !== "pending") return approval;
        const next = await this.store.put({
          ...approval,
          status: status ?? (approved ? "approved" : "rejected"),
          resolvedAt: nowIso(),
        });
        this.business.afterCommit(() => {
          this.waiters.get(id)?.(next.status === "approved");
          this.waiters.delete(id);
          this.hub.publish(GLOBAL_CHANNEL, {
            type: "approval",
            approvalId: id,
          } satisfies GlobalEvent);
        });
        return next;
      })
      .immediate();
  }
  async answer(id: string, text: string): Promise<Approval> {
    await this.ready;
    return this.business
      .transaction(async () => {
        const approval = await this.store.get(id);
        if (!approval) throw new AppError(ErrorCode.NotFound, "审批不存在");
        if (approval.status !== "pending") return approval;
        const payload =
          approval.payload && typeof approval.payload === "object"
            ? (approval.payload as Record<string, unknown>)
            : {};
        await this.store.put({ ...approval, payload: { ...payload, answer: text } });
        return await this.resolve(id, true);
      })
      .immediate();
  }
}
