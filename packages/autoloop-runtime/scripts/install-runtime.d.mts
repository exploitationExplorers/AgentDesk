export function verifyRuntimeArchive(
  bytes: Uint8Array,
  target: string,
): {
  url: string;
  sha256: string;
  archiveSha256: string;
  archiveRoot: string;
};
export function installRuntime(options?: {
  target?: string;
  output?: string;
  archive?: string;
}): Promise<string>;
