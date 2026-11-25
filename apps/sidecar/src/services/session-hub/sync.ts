import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HubSnapshot } from "@agentdesk/shared";

const iCloudDrive = join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
export const hasCloudDrive = () => process.platform === "darwin" && existsSync(iCloudDrive);
/** Each device owns one snapshot. Atomic replacement keeps partial writes out of peer imports. */
export async function syncDeviceFiles(
  local: HubSnapshot,
  accept: (peer: HubSnapshot) => void,
  dir = join(iCloudDrive, "AgentDesk", "SessionHub"),
) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${local.deviceId}.json`),
    json = JSON.stringify(local);
  if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error("本机索引超过 32 MB，无法同步");
  const previous = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  if (previous !== json) {
    const temp = join(dir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, json, { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }
  let skipped = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      entry.name === `${local.deviceId}.json` ||
      !/^[\da-f-]{36}\.json$/i.test(entry.name)
    )
      continue;
    try {
      const source = join(dir, entry.name);
      if ((await stat(source)).size > 32 * 1024 * 1024) throw new Error();
      const peer = HubSnapshot.parse(JSON.parse(await readFile(source, "utf8")));
      if (entry.name !== `${peer.deviceId}.json`) throw new Error();
      accept(peer);
    } catch {
      skipped++;
    }
  }
  return skipped;
}
