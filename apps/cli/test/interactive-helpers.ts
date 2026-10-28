import type { AgentStreamEvent, Approval, RunEventRecord, Task } from "@agentdesk/shared";
import type { apiRequest, ApiResponse, ApiState } from "../src/client.js";
import type { render } from "ink-testing-library";
import assert from "node:assert/strict";
import type { Step, ToolStep } from "../src/interactive/types.js";

export type TestInstance = ReturnType<typeof render>;
export type EventConsumer<T = AgentStreamEvent> = (
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void | Promise<void>,
) => Promise<void>;
export type TaskConsumer = EventConsumer<RunEventRecord>;

export const testState: ApiState = { port: 1, token: "test-token" };

/** JSON 响应使用真实 Response，类型断言与生产 HTTP 边界相同。 */
export function jsonResponse<T>(value: T): ApiResponse<T> {
  return Response.json(value) as ApiResponse<T>;
}

export function mockApi(
  handler: (state: ApiState, path: string, options: RequestInit) => Promise<Response>,
): typeof apiRequest {
  return (async (state: ApiState, path: string, options: RequestInit = {}) =>
    handler(state, path, options)) as typeof apiRequest;
}

export function readBody(options: RequestInit): Record<string, unknown> {
  if (typeof options.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(options.body) as Record<string, unknown>;
}

export function makeApproval(id: string, status: Approval["status"] = "pending"): Approval {
  return {
    id,
    status,
    kind: "tool",
    risk: "confirm",
    title: "确认",
    detail: "",
    payload: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
  };
}

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "Expected a populated test value");
  return value;
}

export function toolStep(value: Step | undefined): ToolStep {
  assert.ok(value?.kind === "tool", "Expected a tool step");
  return value;
}

export const baseTask: Task = {
  id: "task-1",
  status: "queued",
  title: "示例任务",
  goal: "完成示例",
  agent: null,
  conversationId: "conv-1",
  requiresPlanApproval: false,
  currentRunId: null,
  pendingApprovalId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
};
