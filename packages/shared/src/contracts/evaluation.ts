import { z } from "zod";
import { ModelSelection } from "./provider";

export const BehaviorSnapshot = z.object({
  id: z.string().min(1).max(128),
  instructions: z.string().max(8000),
});
export type BehaviorSnapshot = z.infer<typeof BehaviorSnapshot>;

export const EvaluationMode = z.enum(["memory", "agent"]);
export type EvaluationMode = z.infer<typeof EvaluationMode>;

export const EvaluationInput = z.object({
  baseline: BehaviorSnapshot,
  candidate: BehaviorSnapshot,
  mode: EvaluationMode,
  modelSelection: ModelSelection.optional(),
  allowModelCalls: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(600_000).default(180_000),
  maxCases: z.number().int().min(1).max(100).optional(),
  /** Agent 逻辑回合及核心显式重试预算，不包含供应商 SDK 内部网络重试。 */
  maxModelCalls: z.number().int().min(1).max(192).default(96),
});
export type EvaluationInput = z.input<typeof EvaluationInput>;

export const EvaluationCheck = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type EvaluationCheck = z.infer<typeof EvaluationCheck>;

export const EvaluationAttempt = z.object({
  passed: z.boolean(),
  checks: z.array(EvaluationCheck),
  error: z.string().nullable(),
  elapsedMs: z.number().nonnegative(),
  output: z.string(),
  tools: z.array(z.string()),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});
export type EvaluationAttempt = z.infer<typeof EvaluationAttempt>;

export const EvaluationCaseResult = z.object({
  id: z.string(),
  title: z.string(),
  critical: z.boolean(),
  baseline: EvaluationAttempt,
  candidate: EvaluationAttempt,
});
export type EvaluationCaseResult = z.infer<typeof EvaluationCaseResult>;

export const EvaluationDataset = z.object({
  id: z.string(),
  version: z.string(),
  mode: EvaluationMode,
  title: z.string(),
  description: z.string(),
  caseCount: z.number().int().positive(),
  cases: z.array(z.object({ id: z.string(), title: z.string(), critical: z.boolean() })),
});
export type EvaluationDataset = z.infer<typeof EvaluationDataset>;

export const EvaluationRun = z.object({
  id: z.string(),
  mode: EvaluationMode,
  status: z.enum(["completed", "failed", "cancelled"]),
  baseline: BehaviorSnapshot,
  candidate: BehaviorSnapshot,
  baselineHash: z.string(),
  candidateHash: z.string(),
  datasetId: z.string(),
  datasetVersion: z.string(),
  datasetHash: z.string(),
  graderVersion: z.string(),
  environment: z.string(),
  model: z.string().nullable(),
  providerId: z.string().nullable(),
  expectedCaseCount: z.number().int().positive(),
  fullSuite: z.boolean(),
  cases: z.array(EvaluationCaseResult),
  baselinePassed: z.number().int().nonnegative(),
  candidatePassed: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  regressions: z.number().int().nonnegative(),
  criticalFailures: z.number().int().nonnegative(),
  eligibleForRelease: z.boolean(),
  gateReasons: z.array(z.string()),
  gate: z.object({ passed: z.boolean(), reasons: z.array(z.string()) }),
  modelCalls: z.number().int().nonnegative(),
  maxModelCalls: z.number().int().positive(),
  budgetUnit: z.literal("agent-step"),
  notes: z.array(z.string()),
  timeoutMs: z.number().int().positive(),
  createdAt: z.string(),
  completedAt: z.string(),
});
export type EvaluationRun = z.infer<typeof EvaluationRun>;
