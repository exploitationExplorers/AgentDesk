import { lstat, readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DiskUsageEntry } from "@agentdesk/shared";
import { isProtectedVolumePath, pathKey, type DiskEnv, type DiskLimits } from "./disk-rules";
import { volumeForPath, type VolumeRoot } from "./disk-volumes";

const PROJECT_MARKERS = new Set([
  ".git",
  ".hg",
  ".svn",
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "requirements.txt",
]);
const PROGRAM_EXTENSIONS = new Set([".exe", ".dll", ".sys", ".so", ".dylib"]);
const RETAIN_EXTENSIONS = new Set([
  ...PROGRAM_EXTENSIONS,
  ".db",
  ".sqlite",
  ".sqlite3",
  ".vhd",
  ".vhdx",
  ".vmdk",
]);

export interface VolumeFile {
  path: string;
  retain: boolean;
}

/** 有条目预算的只读占用统计。目录仅展示占用，清理候选只包含独立大文件。 */
export async function inspectVolume(
  volume: VolumeRoot,
  roots: VolumeRoot[],
  env: DiskEnv,
  prefixes: string[],
  limits: DiskLimits,
  budget: { left: number },
): Promise<{ usage: DiskUsageEntry[]; files: VolumeFile[]; partial: boolean }> {
  const usage: DiskUsageEntry[] = [];
  const files: VolumeFile[] = [];
  let partial = false;
  const isSelectedVolume = (path: string) => {
    const owner = volumeForPath(path, roots, env);
    return owner && pathKey(owner.path, env.platform) === pathKey(volume.path, env.platform);
  };

  const walk = async (
    target: string,
    allowance: { left: number },
    selectable: boolean,
    depth: number,
  ): Promise<{ bytes: number; truncated: boolean }> => {
    if (budget.left <= 0 || allowance.left <= 0 || depth > 64) {
      return { bytes: 0, truncated: true };
    }
    budget.left -= 1;
    allowance.left -= 1;
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) return { bytes: 0, truncated: true };
      const actual = await realpath(target);
      if (
        !isSelectedVolume(actual) ||
        pathKey(actual, env.platform) !== pathKey(target, env.platform)
      ) {
        return { bytes: 0, truncated: true };
      }
      if (isProtectedVolumePath(actual, volume.path, env, prefixes)) {
        return { bytes: 0, truncated: true };
      }
      if (stat.isFile()) {
        if (stat.size >= limits.largeFileMinBytes && files.length < 200) {
          files.push({
            path: actual,
            retain: !selectable || RETAIN_EXTENSIONS.has(extname(actual).toLowerCase()),
          });
        } else if (stat.size >= limits.largeFileMinBytes) {
          partial = true;
        }
        return { bytes: stat.size, truncated: false };
      }
      if (!stat.isDirectory()) return { bytes: 0, truncated: false };
      const entries = await readdir(actual, { withFileTypes: true });
      const isProjectOrProgram = entries.some(
        (entry) =>
          PROJECT_MARKERS.has(entry.name.toLowerCase()) ||
          (entry.isFile() && PROGRAM_EXTENSIONS.has(extname(entry.name).toLowerCase())),
      );
      let bytes = 0;
      let truncated = false;
      for (const entry of entries) {
        if (budget.left <= 0 || allowance.left <= 0) {
          truncated = true;
          break;
        }
        const measured = await walk(
          join(actual, entry.name),
          allowance,
          selectable && !isProjectOrProgram,
          depth + 1,
        );
        bytes += measured.bytes;
        truncated ||= measured.truncated;
      }
      return { bytes, truncated };
    } catch {
      return { bytes: 0, truncated: true };
    }
  };

  const entries = await readdir(volume.path, { withFileTypes: true });
  for (const entry of entries) {
    if (budget.left <= 0) {
      partial = true;
      break;
    }
    const target = join(volume.path, entry.name);
    if (isProtectedVolumePath(target, volume.path, env, prefixes) || !isSelectedVolume(target))
      continue;
    const measured = await walk(target, { left: limits.maxEntriesPerItem }, true, 0);
    partial ||= measured.truncated;
    if (measured.bytes > 0) usage.push({ path: target, title: entry.name, ...measured });
  }
  usage.sort((a, b) => b.bytes - a.bytes);
  return { usage, files, partial };
}
