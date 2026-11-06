import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/** 密钥写入前收紧目录权限；Windows 的 mode 参数不足以设置 DACL。 */
export function ensurePrivateDirectory(directory: string): string {
  if (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(directory))
    throw new Error("Autoloop 数据目录必须使用本机磁盘绝对路径");
  const absolute = resolve(directory);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (lstatSync(absolute).isSymbolicLink()) throw new Error("Autoloop 数据目录不能是符号链接");
  const actual = realpathSync.native(absolute);
  if (process.platform !== "win32") {
    chmodSync(actual, 0o700);
    return actual;
  }
  if (!/^[A-Za-z]:[\\/]/.test(actual) || actual.startsWith("\\\\"))
    throw new Error("Autoloop 数据目录必须位于本机磁盘");
  if (actual.toLowerCase() !== absolute.toLowerCase())
    throw new Error("Autoloop 数据目录不能经过重解析跳转");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'",
    "$propagation = [System.Security.AccessControl.PropagationFlags]::None",
    "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
    "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inheritance, $propagation, $allow))",
    "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $rights, $inheritance, $propagation, $allow))",
    // 仅持久化 DACL，避免 Set-Acl 连带写入 SACL 而要求管理员特权。
    "[System.IO.Directory]::SetAccessControl($env:AGENTDESK_PRIVATE_DIR, $acl)",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, AGENTDESK_PRIVATE_DIR: actual },
      windowsHide: true,
      timeout: 10_000,
      stdio: "pipe",
    },
  );
  return actual;
}
