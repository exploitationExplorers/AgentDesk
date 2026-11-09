import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShell } from "../src/exec";

let root: string;
let command: string;
let marker: string;
let controller: AbortController;
let processes: number[];

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function started(): Promise<void> {
  await expect
    .poll(() => {
      try {
        const state = JSON.parse(readFileSync(marker, "utf8")) as { pids: number[]; cwd: string };
        processes = state.pids;
        return state.cwd;
      } catch {
        return undefined;
      }
    })
    .toBe(root);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentdesk-shell-"));
  marker = join(root, "running.json");
  controller = new AbortController();
  processes = [];
  writeFileSync(join(root, "worker.cjs"), "setInterval(() => {}, 1000);");
  writeFileSync(
    join(root, "parent.cjs"),
    `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['worker.cjs'], { stdio: 'inherit' });
child.on('spawn', () => {
  require('node:fs').writeFileSync('running.json', JSON.stringify({ pids: [process.pid, child.pid], cwd: process.cwd() }));
});
setInterval(() => {}, 1000);
`,
  );
  command = `"${process.execPath}" parent.cjs`;
});

afterEach(async () => {
  controller.abort();
  for (const pid of processes) {
    if (isRunning(pid)) process.kill(pid, "SIGKILL");
  }
  await expect.poll(() => processes.every((pid) => !isRunning(pid))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

describe("runShell", () => {
  it("streams output and preserves the command exit code", async () => {
    const output: string[] = [];
    const result = await runShell(
      `"${process.execPath}" -e "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7"`,
      { cwd: root, onOutput: (chunk) => output.push(chunk) },
    );
    expect(result).toEqual({ stdout: "out", stderr: "err", code: 7 });
    expect(output.join("")).toContain("out");
    expect(output.join("")).toContain("err");
  });

  it("terminates the shell and its descendants before resolving an abort", async () => {
    const result = runShell(command, { cwd: root, signal: controller.signal });
    await started();
    expect(processes.every(isRunning)).toBe(true);
    controller.abort();
    expect((await result).code).not.toBe(0);
    expect(processes.map(isRunning)).toEqual([false, false]);
  });

  it("terminates descendants before resolving a timeout", async () => {
    const result = runShell(command, {
      cwd: root,
      signal: controller.signal,
      timeoutMs: 2500,
    });
    await started();
    expect((await result).code).not.toBe(0);
    expect(processes.map(isRunning)).toEqual([false, false]);
  });

  it("does not start a command after its signal has already been aborted", async () => {
    controller.abort();
    expect(await runShell(command, { cwd: root, signal: controller.signal })).toMatchObject({
      code: 1,
    });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("returns a failed result when the working directory does not exist", async () => {
    const result = await runShell(command, { cwd: join(root, "missing") });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ENOENT");
  });
});
