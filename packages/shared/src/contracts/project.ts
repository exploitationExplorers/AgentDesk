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
