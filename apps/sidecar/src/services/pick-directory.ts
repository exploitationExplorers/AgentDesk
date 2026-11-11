import { execFile } from "node:child_process";

function execVisible(
  command: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: false,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout: stdout ?? "", code });
      },
    );
  });
}

/** 打开系统目录选择器；取消或不支持时返回 null。 */
export async function pickLocalDirectory(): Promise<string | null> {
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择要导入的本地项目目录'",
      "$dialog.ShowNewFolderButton = $false",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::Out.Write($dialog.SelectedPath)",
      "}",
    ].join("; ");
    const result = await execVisible("powershell.exe", ["-NoProfile", "-STA", "-Command", script]);
    const path = result.stdout.trim();
    return path || null;
  }

  if (process.platform === "darwin") {
    const result = await execVisible("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择要导入的本地项目目录")',
    ]);
    if (result.code !== 0) return null;
    const path = result.stdout.trim().replace(/\/$/, "");
    return path || null;
  }

  return null;
}
