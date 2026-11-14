import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const Connection = z.strictObject({
  server: z.string(),
  token: z.string().min(32),
  roomId: z.string(),
  memberId: z.string(),
});
export type TeamConnection = z.infer<typeof Connection>;
export function teamOrigin(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("团队服务需要 HTTPS 根地址，本机测试可使用回环 HTTP 地址。");
  return url.origin;
}
export async function teamRequest<T>(
  server: string,
  token: string | undefined,
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await fetch(`${teamOrigin(server)}/team-api/v1${path}`, {
    method: data === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`团队请求失败（${response.status}），请检查网页中的成员授权和任务状态。`);
  return (await response.json()) as T;
}
export function saveTeamConnection(home: string, value: TeamConnection) {
  Connection.parse(value);
  teamOrigin(value.server);
  const directory = join(home, "team");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("团队凭据目录不能是符号链接");
  if (process.platform === "win32") {
    const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    }).match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid) throw new Error("无法确认 Windows 用户身份");
    execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], {
      windowsHide: true,
      stdio: "pipe",
    });
  } else chmodSync(directory, 0o700);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(temporary, join(directory, "connection.json"));
}
export function readTeamConnection(home: string): TeamConnection {
  const directory = join(home, "team"),
    file = join(directory, "connection.json");
  if (!existsSync(file)) throw new Error("请先执行 agentdesk team pair --server https://团队地址");
  if (lstatSync(file).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
    throw new Error("团队凭据不能是符号链接");
  const value = Connection.parse(JSON.parse(readFileSync(file, "utf8")));
  teamOrigin(value.server);
  return value;
}
