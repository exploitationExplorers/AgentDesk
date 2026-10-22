import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

let handle: DbHandle | undefined;
let home: string | undefined;

afterEach(() => {
  handle?.close();
  handle = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
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
