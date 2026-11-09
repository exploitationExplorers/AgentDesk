import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, ErrorCode } from "@agentdesk/shared";
import { gitValue } from "./repository-git";

interface LockOwner {
  pid: number;
  instanceId: string;
  holderId: string;
}

/** Locks are never stolen by elapsed time; recovery requires a dead process and reconciliation. */
export class RepositoryLockManager {
  private readonly instanceId = randomUUID();

  private async paths(workspace: string): Promise<string[]> {
    const dirs = await Promise.all([
      gitValue(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      gitValue(workspace, ["rev-parse", "--absolute-git-dir"]),
    ]);
    const canonical = await Promise.all(dirs.map((dir) => realpath(dir)));
    return [...new Set(canonical.map((dir) => join(dir, "agentdesk-write.lock")))].sort();
  }

  async withLock<T>(workspace: string, holderId: string, action: () => Promise<T>): Promise<T> {
    const paths = await this.paths(workspace);
    const acquired: string[] = [];
    const owner: LockOwner = { pid: process.pid, instanceId: this.instanceId, holderId };
    try {
      for (const path of paths) {
        try {
          await writeFile(path, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
          acquired.push(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new AppError(
              ErrorCode.RepoBusy,
              "Repository is already in use or requires crash reconciliation",
            );
          throw error;
        }
      }
      return await action();
    } finally {
      for (const path of acquired.reverse()) {
        const actual = JSON.parse(await readFile(path, "utf8")) as LockOwner;
        if (actual.instanceId === this.instanceId && actual.holderId === holderId)
          await unlink(path);
      }
    }
  }

  async recoverDeadLocks(
    workspace: string,
    reconcile: (holderId: string) => Promise<boolean>,
  ): Promise<void> {
    for (const path of await this.paths(workspace)) {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const owner = JSON.parse(text) as LockOwner;
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.holderId)
        throw new AppError(
          ErrorCode.RepoBusy,
          "Repository lock metadata requires manual inspection",
        );
      try {
        process.kill(owner.pid, 0);
        throw new AppError(ErrorCode.RepoBusy, "Repository lock owner is still alive");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      // Serialize recovery itself so two processes cannot both unlink a newly acquired lock.
      const recoveryPath = `${path}.recovery`;
      await mkdir(recoveryPath);
      try {
        if ((await readFile(path, "utf8")) !== text || !(await reconcile(owner.holderId)))
          throw new AppError(
            ErrorCode.RepoBusy,
            "Repository operation still requires reconciliation",
          );
        await unlink(path);
      } finally {
        const { rmdir } = await import("node:fs/promises");
        await rmdir(recoveryPath);
      }
    }
  }
}
