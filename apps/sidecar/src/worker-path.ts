import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 同时支持源码运行、桌面 bundle 与 npm bundle 的脚本位置。 */
export function aiCommitWorkerPath(moduleUrl = import.meta.url): string {
  const base = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(base, "scripts/ai-commit-worker.mjs"),
    resolve(base, "../scripts/ai-commit-worker.mjs"),
    resolve(base, "../scripts/ai-commit-worker.ts"),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

/** 开发 worker 使用显式 tsx 入口；发行产物只需要 Node，不依赖开发加载器。 */
export function aiCommitWorkerArgs(jobPath: string, moduleUrl = import.meta.url): string[] {
  const worker = aiCommitWorkerPath(moduleUrl);
  if (!worker.endsWith(".ts")) return [worker, jobPath];
  const loader = createRequire(moduleUrl).resolve("tsx");
  return ["--import", pathToFileURL(loader).href, worker, jobPath];
}
