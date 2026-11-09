import { z } from "zod";
import { RemoteId, Sha256Digest } from "./identity";

export const SNAPSHOT_MAX_BYTES = 100 * 1024 * 1024;
export const SNAPSHOT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SNAPSHOT_MAX_FILES = 2_000;

/** 首版统一使用 POSIX 相对路径；拒绝 Windows 别名和跨平台歧义。 */
export const SnapshotPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => {
    if (
      path !== path.normalize("NFC") ||
      /[\\:]/.test(path) ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return false;
    return path
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          segment.toLowerCase() !== ".git" &&
          !/[. ]$/.test(segment) &&
          !/[<>"|?*]/.test(segment) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      );
  }, "Unsafe or unsupported snapshot path");

export const SnapshotEntry = z.discriminatedUnion("kind", [
  z.strictObject({
    path: SnapshotPath,
    kind: z.literal("file"),
    sha256: Sha256Digest,
    size: z.number().int().min(0).max(SNAPSHOT_MAX_FILE_BYTES),
    executable: z.boolean(),
    sourceStatus: z.enum(["staged", "unstaged", "both", "untracked"]),
  }),
  z.strictObject({
    path: SnapshotPath,
    kind: z.literal("deleted"),
    sourceStatus: z.enum(["staged", "unstaged", "both"]),
  }),
]);
export type SnapshotEntry = z.infer<typeof SnapshotEntry>;

const GitObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const SnapshotManifest = z
  .strictObject({
    version: z.literal(1),
    snapshotId: RemoteId,
    sourceHostId: RemoteId,
    sourceProjectId: RemoteId,
    sourceWorkspaceId: RemoteId,
    repositoryIdentity: z.string().min(1).max(512),
    sourceHead: GitObjectId,
    indexTree: GitObjectId,
    branch: z.string().min(1).max(256),
    capturedAt: z.iso.datetime(),
    entries: z.array(SnapshotEntry).min(1).max(SNAPSHOT_MAX_FILES),
    exclusions: z
      .array(z.strictObject({ path: SnapshotPath, reason: z.string().min(1).max(256) }))
      .max(SNAPSHOT_MAX_FILES),
  })
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    let size = 0;
    for (const entry of manifest.entries) {
      const key = entry.path.toLowerCase();
      if (paths.has(key))
        context.addIssue({ code: "custom", message: "Duplicate or case-colliding snapshot path" });
      paths.add(key);
      if (entry.kind === "file") size += entry.size;
    }
    for (const path of paths) {
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index++) {
        if (paths.has(segments.slice(0, index).join("/")))
          context.addIssue({ code: "custom", message: "File/directory collision in snapshot" });
      }
    }
    if (size > SNAPSHOT_MAX_BYTES)
      context.addIssue({ code: "custom", message: "Snapshot exceeds byte quota" });
  });
export type SnapshotManifest = z.infer<typeof SnapshotManifest>;

export const TransferStatus = z.enum([
  "preparing",
  "transferring",
  "validating",
  "importing",
  "verified",
  "failed",
  "expired",
]);
