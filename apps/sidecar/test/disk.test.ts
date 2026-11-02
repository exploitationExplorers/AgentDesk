import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiskScan } from "@agentdesk/shared";
import { openDatabase, type DbHandle } from "../src/db/client";
import { DiskService } from "../src/services/disk";
import {
  applyTierGuard,
  cacheRules,
  isSafeDeletionTarget,
  protectedPrefixes,
  type DiskEnv,
} from "../src/services/disk-rules";
import { SettingsService } from "../src/services/settings";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

let handle: DbHandle | undefined;
let home: string | undefined;

afterEach(() => {
  handle?.close();
  handle = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  vi.restoreAllMocks();
  vi.mocked(fs.statfsSync).mockReset();
});

function winEnv(root: string): DiskEnv {
  return {
    platform: "win32",
    home: root,
    local: join(root, "AppData", "Local"),
    roaming: join(root, "AppData", "Roaming"),
  };
}

describe("disk rules", () => {
  it("已知缓存路径可以清理，家目录和受保护路径不行", () => {
    const env = winEnv("C:\\Users\\me");
    const prefixes = protectedPrefixes(env);
    for (const rule of cacheRules("win32")) {
      for (const target of rule.paths(env)) {
        expect(isSafeDeletionTarget(target, env, prefixes)).toBe(true);
      }
    }
    const mac: DiskEnv = {
      platform: "darwin",
      home: "C:\\Users\\me",
      local: "C:\\Users\\me\\Library",
      roaming: "C:\\Users\\me\\Library\\Application Support",
    };
    const macPrefixes = protectedPrefixes(mac);
    for (const rule of cacheRules("darwin")) {
      for (const target of rule.paths(mac)) {
        expect(isSafeDeletionTarget(target, mac, macPrefixes)).toBe(true);
      }
    }
    expect(isSafeDeletionTarget(env.home, env, prefixes)).toBe(false);
    expect(isSafeDeletionTarget(join(env.home, "Downloads"), env, prefixes)).toBe(false);
    expect(isSafeDeletionTarget(join(env.home, ".ssh", "id_ed25519"), env, prefixes)).toBe(false);
    expect(
      isSafeDeletionTarget(join(env.local, "Google", "Chrome", "User Data"), env, prefixes),
    ).toBe(false);
    expect(
      cacheRules("win32").some((rule) => rule.paths(env).some((p) => p.includes("Library"))),
    ).toBe(false);
    expect(cacheRules("darwin").some((rule) => rule.id === "xcode-derived")).toBe(true);
  });

  it("模型不能把档位改得更激进", () => {
    expect(
      applyTierGuard(
        {
          tier: "optional",
          ruleTier: "optional",
          category: "user",
          regenerable: false,
          protected: false,
          locked: true,
          hasGit: false,
        },
        "primary",
      ),
    ).toBe("optional");
    expect(
      applyTierGuard(
        {
          tier: "keep",
          ruleTier: "keep",
          category: "user",
          regenerable: false,
          protected: false,
          locked: true,
          hasGit: true,
        },
        "primary",
      ),
    ).toBe("keep");
    expect(
      applyTierGuard(
        {
          tier: "primary",
          ruleTier: "primary",
          category: "dev",
          regenerable: true,
          protected: true,
          locked: false,
          hasGit: false,
        },
        "primary",
      ),
    ).toBe("keep");
    expect(
      applyTierGuard(
        {
          tier: "primary",
          ruleTier: "primary",
          category: "dev",
          regenerable: true,
          protected: false,
          locked: false,
          hasGit: false,
        },
        "keep",
      ),
    ).toBe("keep");
  });
});

describe("disk service", () => {
  it("只删除勾选的缓存，密钥和版本库保留", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentdesk-disk-"));
    home = root;
    const env = winEnv(root);
    mkdirSync(join(env.local, "npm-cache", "content"), { recursive: true });
    writeFileSync(join(env.local, "npm-cache", "content", "blob"), Buffer.alloc(32));
    mkdirSync(join(root, ".ssh"), { recursive: true });
    writeFileSync(join(root, ".ssh", "id_ed25519"), "secret");
    mkdirSync(join(root, "Downloads"), { recursive: true });
    writeFileSync(join(root, "Downloads", "movie.bin"), Buffer.alloc(64));
    mkdirSync(join(root, "Documents", "repo", ".git"), { recursive: true });
    writeFileSync(join(root, "Documents", "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, "Documents", "repo", "README.md"), Buffer.alloc(64));

    handle = openDatabase(":memory:");
    const settings = new SettingsService(handle.db);
    settings.update({ diskOptionalAction: "delete", diskThresholdGB: 15 });
    const disk = new DiskService(
      settings,
      { resolve: async () => [] },
      {
        env,
        systemTrash: false,
        volumes: [{ path: root, label: "测试盘" }],
        limits: {
          knownMinBytes: 1,
          genericMinBytes: 1,
          largeFileMinBytes: 16,
          largeDirMinBytes: 16,
          maxEntries: 5_000,
          maxEntriesPerItem: 1_000,
        },
      },
    );

    const report = await disk.scan();
    const npm = report.items.find((item) => item.path.includes("npm-cache"));
    const movie = report.items.find((item) => item.path.endsWith("movie.bin"));
    const repo = report.items.find((item) => item.path.endsWith(`${join("Documents", "repo")}`));
    expect(npm?.tier).toBe("primary");
    expect(npm?.selectable).toBe(true);
    expect(movie?.tier).toBe("optional");
    expect(repo).toBeUndefined();
    expect(report.items.some((item) => item.path.includes(".ssh"))).toBe(false);

    const result = await disk.clean({
      scanId: report.id,
      ids: [npm!.id, movie!.id, "missing-item"],
    });
    expect(result.cleaned.map((item) => item.id).sort()).toEqual([npm!.id, movie!.id].sort());
    expect(result.skipped.some((item) => item.id === "missing-item")).toBe(true);
    expect(readFileSync(join(root, ".ssh", "id_ed25519"), "utf8")).toBe("secret");
    expect(readFileSync(join(root, "Documents", "repo", "README.md"))).toHaveLength(64);
    expect(() => readFileSync(join(root, "Downloads", "movie.bin"))).toThrow();
    expect(() => readFileSync(join(env.local, "npm-cache", "content", "blob"))).toThrow();

    await expect(disk.clean({ scanId: "missing", ids: [npm!.id] })).rejects.toThrow(/重新扫描/);
  });
});

function multipleDisks(maxEntries = 5000) {
  home = mkdtempSync(join(tmpdir(), "agentdesk-volumes-"));
  const system = join(home, "system");
  const data = join(home, "data");
  const env = winEnv(join(system, "Users", "test"));
  mkdirSync(env.home, { recursive: true });
  mkdirSync(data, { recursive: true });
  handle = openDatabase(":memory:");
  const settings = new SettingsService(handle.db);
  settings.update({ diskOptionalAction: "delete" });
  const disk = new DiskService(
    settings,
    { resolve: async () => [] },
    {
      env,
      systemTrash: false,
      volumes: [
        { path: system, label: "系统盘" },
        { path: data, label: "数据盘" },
      ],
      limits: {
        knownMinBytes: 1,
        genericMinBytes: 1,
        largeFileMinBytes: 16,
        largeDirMinBytes: 16,
        maxEntries,
        maxEntriesPerItem: 1000,
      },
    },
  );
  const file = (path: string, bytes = 64) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes));
    return path;
  };
  return { disk, env, system, data, file };
}

describe("多磁盘扫描", () => {
  it("枚举不同磁盘，优先推荐低空间磁盘，并拒绝未枚举路径", async () => {
    const { disk, system, data } = multipleDisks();
    const actualStats = fs.statfsSync(data);
    vi.mocked(fs.statfsSync).mockImplementation((path) => ({
      ...actualStats,
      bsize: 1024 ** 3,
      blocks: 100,
      bavail: path === data ? 5 : 30,
    }));
    const status = await disk.status();
    expect(status.volumes.map((volume) => volume.volumePath)).toEqual([system, data]);
    expect(status.volumePath).toBe(data);
    expect(status.low).toBe(true);
    expect((await disk.status(system)).isHome).toBe(true);
    await expect(disk.scan(join(data, "unknown"))).rejects.toThrow(/磁盘不可用/);
    await expect(disk.scan(join(data, ".."))).rejects.toThrow(/磁盘不可用/);
  });

  it("数据盘按实际目录统计，仅清理勾选的大文件，不混入系统盘缓存", async () => {
    const { disk, env, system, data, file } = multipleDisks();
    const cache = file(join(env.local, "npm-cache", "content", "blob"));
    const movie = file(join(data, "Downloads", "nested", "movie.mp4"), 128);
    const archive = file(join(data, "archive.zip"), 32);
    const report = DiskScan.parse(await disk.scan(data));
    expect(report.status.volumePath).toBe(data);
    expect(report.items.map((item) => item.path).sort()).toEqual([movie, archive].sort());
    expect(report.items.every((item) => item.tier === "optional" && item.selectable)).toBe(true);
    expect(report.usage[0]).toMatchObject({ path: join(data, "Downloads"), bytes: 128 });
    const selected = report.items.find((item) => item.path === movie)!;
    const result = await disk.clean({ scanId: report.id, ids: [selected.id] });
    expect(result.freedBytes).toBe(128);
    expect(() => readFileSync(movie)).toThrow();
    expect(readFileSync(cache)).toHaveLength(64);
    expect(readFileSync(archive)).toHaveLength(32);
    const otherReport = await disk.scan(system);
    expect(otherReport.items.some((item) => item.path.includes("npm-cache"))).toBe(true);
    expect(otherReport.items.some((item) => item.path === archive)).toBe(false);
    await expect(disk.clean({ scanId: report.id, ids: [selected.id] })).rejects.toThrow(/重新扫描/);
  });

  it("保留数据盘上的仓库、应用、数据库、密钥和系统内容", async () => {
    const { disk, data, file } = multipleDisks();
    file(join(data, "work", "repo", ".git", "HEAD"));
    const repoFile = file(join(data, "work", "repo", "asset.zip"));
    file(join(data, "apps", "custom", "app.exe"));
    const appFile = file(join(data, "apps", "custom", "assets", "bundle.bin"));
    const dbFile = file(join(data, "data", "important.sqlite"));
    const secrets = file(join(data, "backup", ".ssh", "id_ed25519"));
    const windows = file(join(data, "Windows", "important.bin"));
    const protectedFile = file(join(data, "System Volume Information", "index.bin"));
    const report = await disk.scan(data);
    for (const path of [repoFile, appFile, dbFile]) {
      expect(report.items.find((item) => item.path === path)).toMatchObject({
        tier: "keep",
        selectable: false,
      });
    }
    for (const path of [secrets, windows, protectedFile]) {
      expect(report.items.some((item) => item.path === path)).toBe(false);
    }
    const result = await disk.clean({
      scanId: report.id,
      ids: report.items.map((item) => item.id),
    });
    expect(result.cleaned).toEqual([]);
    for (const path of [repoFile, appFile, dbFile, secrets, windows, protectedFile]) {
      expect(readFileSync(path)).toHaveLength(64);
    }
  });

  it("不跟随跨盘目录链接，且扫描达到上限时明确标记不完整", async () => {
    const { disk, system, data, file } = multipleDisks(220);
    const original = file(join(system, "outside", "secret.zip"));
    symlinkSync(
      join(system, "outside"),
      join(data, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (let index = 0; index < 100; index++) file(join(data, "many", `${index}.zip`));
    const report = await disk.scan(data);
    expect(report.partial).toBe(true);
    expect(
      report.items.some((item) => item.path === original || item.path.includes("linked")),
    ).toBe(false);
    expect(report.usage.find((item) => item.title === "many")?.truncated).toBe(true);
  });

  it("清理前拒绝扫描后被替换成目录或含仓库的缓存", async () => {
    const { disk, env, data, system, file } = multipleDisks();
    const target = file(join(data, "archive.zip"));
    const report = await disk.scan(data);
    rmSync(target);
    mkdirSync(target);
    file(join(target, "keep.bin"));
    const result = await disk.clean({ scanId: report.id, ids: [report.items[0]!.id] });
    expect(result.cleaned).toEqual([]);
    expect(readFileSync(join(target, "keep.bin"))).toHaveLength(64);
    const cache = join(env.local, "npm-cache");
    file(join(cache, "blob"));
    const cacheReport = await disk.scan(system);
    file(join(cache, "nested", ".git", "HEAD"));
    const cacheResult = await disk.clean({
      scanId: cacheReport.id,
      ids: cacheReport.items.map((item) => item.id),
    });
    expect(cacheResult.cleaned).toEqual([]);
    expect(readFileSync(join(cache, "blob"))).toHaveLength(64);
  });
});
