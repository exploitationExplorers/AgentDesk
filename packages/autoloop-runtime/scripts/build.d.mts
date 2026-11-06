export function copyAutoloopRuntime(
  targetDirectory: string,
  options?: { nodePath?: string },
): {
  schemaVersion: number;
  upstreamCommit: string;
  nodeVersion: string;
  sqliteVersion: string;
  modules: string;
  platform: string;
  arch: string;
  files: Record<string, string>;
};
