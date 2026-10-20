import { z } from "zod";

export const GitPlatform = z.enum(["github", "gitee", "gitlab", "unknown"]);
export type GitPlatform = z.infer<typeof GitPlatform>;

export const CommitInfo = z.object({
  hash: z.string(),
  message: z.string(),
  author: z.string(),
  date: z.string(),
});
export type CommitInfo = z.infer<typeof CommitInfo>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  platform: GitPlatform,
  remoteUrl: z.string().nullable(),
  host: z.string().nullable(),
  owner: z.string().nullable(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  dirtyFiles: z.number().int(),
  ahead: z.number().int(),
  behind: z.number().int(),
  lastCommit: CommitInfo.nullable(),
  pinned: z.boolean(),
  tags: z.array(z.string()),
  scannedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const RemoteActivity = z.object({
  kind: z.enum(["pull_request", "merge_request", "issue"]),
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  author: z.string(),
  updatedAt: z.string(),
});
export type RemoteActivity = z.infer<typeof RemoteActivity>;

export const GitAccount = z.object({
  platform: z.enum(["github", "gitee", "gitlab"]),
  host: z.string(),
  hasToken: z.boolean(),
});
export type GitAccount = z.infer<typeof GitAccount>;

export const ClaudeSession = z.object({
  id: z.string(),
  projectPath: z.string(),
  title: z.string(),
  messageCount: z.number(),
  updatedAt: z.string(),
});
export type ClaudeSession = z.infer<typeof ClaudeSession>;

export const LaunchTarget = z.enum(["cursor", "claude", "terminal", "explorer"]);
export type LaunchTarget = z.infer<typeof LaunchTarget>;

/** AI 提交推送预览：状态摘要 + 建议的 commit message */
export const AiCommitPreview = z.object({
  projectId: z.string(),
  branch: z.string().nullable(),
  status: z.string(),
  stagedFiles: z.array(z.string()),
  unstagedFiles: z.array(z.string()),
  hasStaged: z.boolean(),
  hasUnstaged: z.boolean(),
  ahead: z.number().int(),
  willStageAll: z.boolean(),
  suggestedMessage: z.string(),
  diffPreview: z.string(),
});
export type AiCommitPreview = z.infer<typeof AiCommitPreview>;

export const AiCommitResult = z.object({
  projectId: z.string(),
  message: z.string(),
  commitHash: z.string(),
  pushed: z.boolean(),
  pushOutput: z.string(),
  project: Project.optional(),
});
export type AiCommitResult = z.infer<typeof AiCommitResult>;

export const AiCommitInput = z.object({
  /** 有本地改动时必填；仅推送未推送提交时可为空 */
  message: z.string().max(2_000).default(""),
  /** 暂存区为空时是否 git add -A；默认 true */
  stageAll: z.boolean().default(true),
  /** 提交后是否 push；默认 true */
  push: z.boolean().default(true),
});
export type AiCommitInput = z.infer<typeof AiCommitInput>;

/** 异步提交任务：独立进程跑 git，避免 husky 改文件触发 sidecar 热重载导致 Failed to fetch */
export const AiCommitJob = z.object({
  id: z.string(),
  status: z.enum(["running", "done", "error"]),
  error: z.string().optional(),
  result: AiCommitResult.optional(),
});
export type AiCommitJob = z.infer<typeof AiCommitJob>;
