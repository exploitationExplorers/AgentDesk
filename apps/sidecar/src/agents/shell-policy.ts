import { run, runShell, type ExecResult } from "@agentdesk/integrations";
import type { RiskLevel } from "@agentdesk/shared";

/** 仅放行明确的参数组合；未知参数继续使用已有审批路径。 */
const GIT_READONLY_FLAGS: Record<string, ReadonlySet<string>> = {
  "rev-parse": new Set([
    "--verify",
    "--quiet",
    "-q",
    "--short",
    "--show-toplevel",
    "--show-prefix",
    "--show-cdup",
    "--git-dir",
    "--absolute-git-dir",
    "--is-inside-work-tree",
    "--is-bare-repository",
    "--abbrev-ref",
    "--symbolic-full-name",
    "--end-of-options",
  ]),
  "ls-files": new Set([
    "--others",
    "-o",
    "--exclude-standard",
    "--cached",
    "-c",
    "--modified",
    "-m",
    "--deleted",
    "-d",
    "--stage",
    "-s",
    "--unmerged",
    "-u",
    "--error-unmatch",
    "-z",
    "--full-name",
  ]),
  status: new Set([
    "--short",
    "-s",
    "--branch",
    "-b",
    "--porcelain",
    "--porcelain=v1",
    "--porcelain=v2",
    "--untracked-files=no",
    "-uno",
  ]),
  branch: new Set([
    "--list",
    "-l",
    "--all",
    "-a",
    "--remotes",
    "-r",
    "--verbose",
    "-v",
    "-vv",
    "--show-current",
    "--no-color",
  ]),
  diff: new Set([
    "--stat",
    "--numstat",
    "--shortstat",
    "--name-only",
    "--name-status",
    "--cached",
    "--staged",
    "--check",
    "--summary",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
  ]),
  log: new Set([
    "--oneline",
    "--all",
    "--graph",
    "--decorate",
    "--no-decorate",
    "--stat",
    "--name-only",
    "--name-status",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
  ]),
  show: new Set([
    "--stat",
    "--numstat",
    "--shortstat",
    "--name-only",
    "--name-status",
    "--summary",
    "--oneline",
    "--no-patch",
    "-s",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
  ]),
};

type ReadOnlyGitCommand = { args: string[]; when: "always" | "success" | "failure" };

/** 只解析不含展开、重定向或管道的 Git 查询；执行时直接传 argv，避免不同 shell 的语义差异。 */
function readOnlyGitCommands(command: string): ReadOnlyGitCommand[] | null {
  const text = command.trim();
  if (
    !text ||
    /[`$><%^!(){}]/.test(text) ||
    [...text].some(
      (char) =>
        (char.charCodeAt(0) < 32 && !["\t", "\r", "\n"].includes(char)) ||
        char.charCodeAt(0) === 127,
    )
  )
    return null;
  const commands: ReadOnlyGitCommand[] = [];
  let args: string[] = [];
  let token = "";
  let started = false;
  let quote = "";
  let when: ReadOnlyGitCommand["when"] = "always";
  const flushToken = () => {
    if (started) args.push(token);
    token = "";
    started = false;
  };
  const flushCommand = () => {
    flushToken();
    if (args.shift() !== "git" || !isReadOnlyGit(args)) return false;
    commands.push({ args, when });
    args = [];
    return true;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = "";
      else {
        if (char === "\n" || char === "\r" || (char === "\\" && text[index + 1] === quote))
          return null;
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      if (token.endsWith("\\")) return null;
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") flushToken();
    else if (char === ";" || char === "\n" || char === "\r" || char === "&" || char === "|") {
      if ((char === "&" || char === "|") && text[index + 1] !== char) return null;
      if (!flushCommand()) return null;
      when = char === "&" ? "success" : char === "|" ? "failure" : "always";
      if (char === "&" || char === "|" || (char === "\r" && text[index + 1] === "\n")) index++;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote || !flushCommand()) return null;
  return commands;
}

function isReadOnlyGit(args: string[]): boolean {
  let offset = 0;
  while (
    args[offset] === "--no-pager" ||
    args[offset] === "--no-optional-locks" ||
    args[offset] === "-c"
  ) {
    if (
      args[offset++] === "-c" &&
      !/^(?:core\.safecrlf=(?:false|true|warn)|core\.quotepath=(?:false|true)|color\.ui=(?:false|never))$/i.test(
        args[offset++] ?? "",
      )
    )
      return false;
  }
  const [command, ...rest] = args.slice(offset);
  if (command === "remote") return rest.length === 1 && rest[0] === "-v";
  if (!command) return false;
  const flags = GIT_READONLY_FLAGS[command];
  if (!flags) return false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]!;
    if (argument === "--" && ["status", "diff", "log", "show", "ls-files"].includes(command))
      return rest.slice(index + 1).every((path) => path.length > 0);
    if (flags.has(argument)) continue;
    if (command === "rev-parse" && /^--short=\d{1,2}$/.test(argument)) continue;
    if ((command === "log" || command === "show") && argument === "-n") {
      if (!/^\d{1,5}$/.test(rest[++index] ?? "")) return false;
      continue;
    }
    if (
      (command === "log" || command === "show") &&
      /^(?:-\d{1,5}|--max-count=\d{1,5})$/.test(argument)
    )
      continue;
    // branch 的位置参数可创建分支，不能按普通 revision 放行。
    if (
      ["diff", "log", "show", "rev-parse", "ls-files"].includes(command) &&
      /^[a-zA-Z0-9_./:@~-]+$/.test(argument) &&
      !argument.startsWith("-")
    )
      continue;
    return false;
  }
  return true;
}

export function shellRisk(command: string): RiskLevel {
  if (readOnlyGitCommands(command)) return "safe";
  const trimmed = command.trim();
  // 同时防止 POSIX/cmd/PowerShell 的分隔、转义与变量展开改变已检查的命令。
  if (
    /[;&|`$><%^!(){}"']/.test(trimmed) ||
    [...trimmed].some((character) => character.charCodeAt(0) < 32 && character !== "\t")
  )
    return "dangerous";
  const [executable, ...args] = trimmed.split(/\s+/);
  if (executable === "git") return "dangerous";
  if (
    /^(node|npm|pnpm|yarn|bun|python|go|java|cargo|rustc)$/.test(executable ?? "") &&
    args.length === 1 &&
    (args[0] === "-v" || args[0] === "--version")
  )
    return "safe";
  if (executable === "echo") return "safe";
  if ((executable === "pwd" || executable === "whoami") && args.length === 0) return "safe";
  if (executable === "ls" && args.every((arg) => /^-(?:[alh]+)$/.test(arg))) return "safe";
  if (executable === "dir" && args.every((arg) => /^\/(?:a|b|s)$/i.test(arg))) return "safe";
  return "dangerous";
}

/** 必须在调用前完成审批；只读查询采用与风险判断一致的解析结果。 */
export async function runCheckedShell(
  command: string,
  options: Parameters<typeof runShell>[1] = {},
): Promise<ExecResult> {
  const queries = readOnlyGitCommands(command);
  if (!queries) return runShell(command, options);
  let code = 0;
  let stdout = "";
  let stderr = "";
  for (const query of queries) {
    options.signal?.throwIfAborted();
    if (query.when === "success" && code !== 0) continue;
    if (query.when === "failure" && code === 0) continue;
    const args = [...query.args];
    let subcommand = 0;
    while (args[subcommand]?.startsWith("-")) subcommand += args[subcommand] === "-c" ? 2 : 1;
    if (["diff", "log", "show"].includes(args[subcommand] ?? ""))
      args.splice(subcommand + 1, 0, "--no-ext-diff", "--no-textconv");
    const result = await run("git", ["--no-pager", "--no-optional-locks", ...args], options);
    code = result.code;
    stdout += result.stdout;
    stderr += result.stderr;
    options.onOutput?.(result.stdout + result.stderr);
  }
  return { code, stdout, stderr };
}
