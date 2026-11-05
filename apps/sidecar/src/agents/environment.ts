import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PYTHON_CHECK =
  "import importlib.util,json,sys; print(json.dumps({name: importlib.util.find_spec(name) is not None for name in sys.argv[1:]}))";

function checkedNames(names: string[], pattern: RegExp): string[] {
  if (names.length > 20 || names.some((name) => !pattern.test(name))) {
    throw new Error("环境检查只接受最多 20 个程序或顶层 Python 模块名称");
  }
  return [...new Set(names)];
}

function availableProgram(name: string): boolean {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) =>
      extensions.some((extension) => existsSync(join(directory, name + extension))),
    );
}

/** 只运行固定的模块探测脚本，输入仅作为模块名传入 argv。 */
export async function inspectEnvironment(
  executables: string[] = [],
  pythonModules: string[] = [],
  signal?: AbortSignal,
  nodeModules: string[] = [],
) {
  const programs = checkedNames(executables, /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
  const modules = checkedNames(pythonModules, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
  const nodeNames = checkedNames(
    nodeModules,
    /^(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/,
  );
  const require = createRequire(join(process.cwd(), "package.json"));
  const node = Object.fromEntries(
    nodeNames.map((name) => {
      try {
        require.resolve(name);
        return [name, true];
      } catch {
        return [name, false];
      }
    }),
  );
  const base = {
    platform: process.platform,
    homeDirectory: homedir(),
    workingDirectory: process.cwd(),
    nodeModules: node,
  };
  const available = Object.fromEntries(programs.map((name) => [name, availableProgram(name)]));
  if (!modules.length) return { ...base, programs: available, python: null };
  for (const executable of ["python", "python3"]) {
    if (!availableProgram(executable)) continue;
    try {
      const { stdout } = await execFileAsync(executable, ["-I", "-c", PYTHON_CHECK, ...modules], {
        timeout: 5000,
        windowsHide: true,
        signal,
      });
      return {
        ...base,
        programs: available,
        python: {
          available: true,
          modules: JSON.parse(stdout) as Record<string, boolean>,
        },
      };
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return {
    ...base,
    programs: available,
    python: { available: false, modules: {} },
  };
}
