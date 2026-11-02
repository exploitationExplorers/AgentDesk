import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverVolumes, volumeForPath } from "../src/services/disk-volumes";
import { DiskService } from "../src/services/disk";
import { openDatabase, type DbHandle } from "../src/db/client";
import { SettingsService } from "../src/services/settings";

const subprocess = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: subprocess.run }) };
});

const env = {
  platform: "win32" as const,
  home: "C:\\Users\\test",
  local: "C:\\Users\\test\\AppData\\Local",
  roaming: "C:\\Users\\test\\AppData\\Roaming",
};
let root: string | undefined;
let database: DbHandle | undefined;

afterEach(() => {
  subprocess.run.mockReset();
  database?.close();
  database = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("磁盘枚举与回收站范围", () => {
  it("读取真实枚举结果中的任意盘符，兼容单盘和无盘", async () => {
    const drives = [
      { path: "C:\\", label: "Windows" },
      { path: "F:\\", label: "备份" },
    ];
    subprocess.run.mockResolvedValueOnce({ stdout: JSON.stringify(drives) });
    expect(await discoverVolumes(env)).toEqual(drives);
    expect(subprocess.run.mock.calls[0]?.[1].at(-1)).toContain("'Fixed', 'Removable'");
    subprocess.run.mockResolvedValueOnce({ stdout: JSON.stringify(drives[1]) });
    expect(await discoverVolumes(env)).toEqual([drives[1]]);
    subprocess.run.mockResolvedValueOnce({ stdout: "" });
    expect(await discoverVolumes(env)).toEqual([]);
  });

  it("嵌套挂载点归属到最具体的卷", () => {
    const volumes = [
      { path: "C:\\", label: "System" },
      { path: "C:\\mounted", label: "Mounted" },
    ];
    expect(volumeForPath("C:\\mounted\\movie.zip", volumes, env)?.label).toBe("Mounted");
    expect(volumeForPath("C:\\mounted-other\\movie.zip", volumes, env)?.label).toBe("System");
  });

  it("回收站统计与清空都绑定扫描的卷，移动文件不虚报释放空间", async () => {
    root = mkdtempSync(join(tmpdir(), "agentdesk-recycle-"));
    const localEnv = {
      ...env,
      home: join(root, "profile"),
      local: join(root, "local"),
      roaming: join(root, "roaming"),
    };
    const data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "archive.zip"), Buffer.alloc(64));
    database = openDatabase(":memory:");
    const settings = new SettingsService(database.db);
    const disk = new DiskService(
      settings,
      { resolve: async () => [] },
      {
        env: localEnv,
        volumes: [{ path: data, label: "数据" }],
        systemTrash: true,
        limits: {
          knownMinBytes: 1,
          genericMinBytes: 1,
          largeFileMinBytes: 16,
          largeDirMinBytes: 16,
          maxEntries: 1000,
          maxEntriesPerItem: 500,
        },
      },
    );
    subprocess.run.mockResolvedValue({ stdout: "32" });
    const report = await disk.scan(data);
    const queryCall = subprocess.run.mock.calls.find((call) =>
      call[1].at(-1).includes("SHQueryRecycleBin"),
    );
    expect(queryCall?.[2].env.AGENTDESK_RECYCLE_ROOT).toBe(data);
    const file = report.items.find((item) => item.mode !== "recycle")!;
    const moved = await disk.clean({ scanId: report.id, ids: [file.id] });
    expect(moved.cleaned[0]?.action).toBe("trash");
    expect(moved.freedBytes).toBe(0);
    const recycle = report.items.find((item) => item.mode === "recycle")!;
    expect(recycle.path).toBe(join(data, "$RECYCLE.BIN"));
    const emptied = await disk.clean({ scanId: report.id, ids: [recycle.id] });
    expect(emptied.freedBytes).toBe(32);
    const clearCall = subprocess.run.mock.calls.find((call) =>
      call[1].at(-1).includes("Clear-RecycleBin"),
    );
    expect(clearCall?.[1].at(-1)).toContain("-DriveLetter $env:AGENTDESK_RECYCLE_DRIVE");
    expect(clearCall?.[2].env.AGENTDESK_RECYCLE_DRIVE).toBe(data[0]);
  });
});
