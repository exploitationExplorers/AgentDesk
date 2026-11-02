import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isStrictChild, pathKey, type DiskEnv } from "./disk-rules";

export interface VolumeRoot {
  path: string;
  label: string;
}

const execFileAsync = promisify(execFile);

/** 只枚举已就绪的本地卷，避免探测断开的网络盘或光驱。 */
export async function discoverVolumes(env: DiskEnv): Promise<VolumeRoot[]> {
  if (env.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -in @('Fixed', 'Removable') -and $_.IsReady } | ForEach-Object { @{ path = $_.Name; label = $_.VolumeLabel } }) | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 15_000, encoding: "utf8" },
    );
    const parsed: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/, "") || "[]");
    return z
      .array(z.object({ path: z.string().regex(/^[A-Z]:\\$/i), label: z.string() }))
      .parse(Array.isArray(parsed) ? parsed : [parsed]);
  }
  const roots: VolumeRoot[] = [{ path: parse(env.home).root, label: "系统磁盘" }];
  if (env.platform === "darwin") {
    const entries = await readdir("/Volumes", { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        roots.push({ path: join("/Volumes", entry.name), label: entry.name });
      }
    }
  } else if (env.platform === "linux") {
    const mounts = await readFile("/proc/self/mountinfo", "utf8");
    for (const line of mounts.trim().split("\n")) {
      const [fields, device] = line.split(" - ");
      if (!fields || !device) continue;
      const [type, source] = device.split(" ");
      const path = fields
        .split(" ")[4]
        ?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
      if (
        path &&
        source?.startsWith("/dev/") &&
        type !== "squashfs" &&
        path !== "/" &&
        !/^\/(boot|dev|proc|sys)(\/|$)/.test(path)
      ) {
        roots.push({ path, label: path });
      }
    }
  }
  return roots;
}

/** 挂载点嵌套时，以最具体的卷为准。 */
export function volumeForPath(
  target: string,
  roots: VolumeRoot[],
  env: DiskEnv,
): VolumeRoot | undefined {
  return roots
    .filter(
      (root) =>
        pathKey(root.path, env.platform) === pathKey(target, env.platform) ||
        isStrictChild(root.path, target, env.platform),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
}
