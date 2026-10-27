import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 同时支持源码运行、桌面 bundle 与 npm bundle 的脚本位置。 */
export function aiCommitWorkerPath(moduleUrl = import.meta.url): string {
  const base = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(base, "scripts/ai-commit-worker.mjs"),
    resolve(base, "../scripts/ai-commit-worker.mjs"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}
