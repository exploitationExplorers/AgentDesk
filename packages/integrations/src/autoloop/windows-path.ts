import { isAbsolute as posixIsAbsolute, normalize as posixNormalize } from "node:path/posix";
import { normalize as win32Normalize } from "node:path/win32";

export interface WorkspacePathOptions {
  platform?: NodeJS.Platform;
  allowUnc?: boolean;
}

/**
 * 校验自动化绑定里的工作区路径。事件正文不能覆盖这个值，执行前仍需由 sidecar
 * 按项目权限再次确认目录是否属于当前用户授权范围。
 */
export function validateWorkspacePath(value: string, options: WorkspacePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (!value.trim()) throw new Error("工作区路径不能为空");
  if (
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("工作区路径不能含控制字符");

  if (platform === "win32") {
    const input = value.replaceAll("/", "\\");
    if (/^\\\\[?.]\\/.test(input) || /^\\\?\?\\/.test(input))
      throw new Error("不支持设备路径或扩展路径");
    const unc = input.startsWith("\\\\");
    if (unc && options.allowUnc !== true) throw new Error("默认不支持 UNC 工作区路径");
    if (unc ? !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(input) : !/^[A-Za-z]:\\/.test(input))
      throw new Error("Windows 工作区必须是包含盘符或共享名的绝对路径");
    const parts = (unc ? input.slice(2) : input.slice(3)).split("\\");
    for (const part of parts) {
      if (!part || part === "." || part === "..") continue;
      if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part))
        throw new Error("Windows 工作区路径含无效名称");
      if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
        throw new Error("Windows 工作区路径不能使用设备名称");
    }
    return win32Normalize(input);
  }

  if (!posixIsAbsolute(value)) throw new Error("工作区必须是绝对路径");
  return posixNormalize(value);
}

/** 只用于判断输入是否是 Windows 盘符相对路径，例如 `D:relative`。 */
export function isWindowsDriveRelativePath(value: string): boolean {
  return /^[A-Za-z]:(?:$|[^\\/])/.test(value);
}
