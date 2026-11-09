import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { DeviceIdentity, RemoteId } from "@agentdesk/shared";

const Credentials = z.strictObject({
  schemaVersion: z.literal(1),
  server: z.string().url(),
  hostId: RemoteId,
  userId: RemoteId,
  identity: DeviceIdentity,
  projects: z.array(RemoteId).min(1).max(32),
  privateKey: z.string().min(32).max(256),
  enabled: z.boolean(),
});
export type ConnectorCredentials = z.infer<typeof Credentials>;
export function connectorPath(home: string) {
  return join(home, "connect", "device.json");
}
export function serverOrigin(input: string) {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("连接服务器必须是 HTTPS 根地址，例如 https://agent.example.com。");
  return url.origin;
}
export function readConnector(home: string): ConnectorCredentials | undefined {
  const file = connectorPath(home);
  if (!existsSync(file)) return;
  if (lstatSync(file).isSymbolicLink() || lstatSync(join(home, "connect")).isSymbolicLink())
    throw new Error("设备凭据不能使用符号链接。");
  const value = Credentials.parse(JSON.parse(readFileSync(file, "utf8")));
  serverOrigin(value.server);
  return value;
}
export function writeConnector(home: string, input: ConnectorCredentials) {
  const value = Credentials.parse(input);
  serverOrigin(value.server);
  const directory = join(home, "connect");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("设备凭据目录不能使用符号链接。");
  // Windows 上 mode 不设置 ACL；先收紧目录，之后才写入私钥。
  if (process.platform === "win32") {
    const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    }).match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw new Error("无法确认当前 Windows 用户身份，未保存设备私钥。");
    execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {
      stdio: "pipe",
      windowsHide: true,
    });
  } else chmodSync(directory, 0o700);
  const temporary = join(directory, `device-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, connectorPath(home));
}
