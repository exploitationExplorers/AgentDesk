import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fsGlob, fsPatch, fsRead, fsSearch, fsWrite, resolveUnderRoot } from "../src/fs/project-fs";
import { fileChange } from "../src/fs/file-change";

let area: string;
let root: string;
beforeAll(async () => {
  area = await mkdtemp(join(tmpdir(), "agentdesk-edit-"));
  root = join(area, "project");
  await mkdir(root);
});
afterAll(async () => {
  await rm(area, { recursive: true, force: true });
});

describe("原生编码文件工具", () => {
  it("生成落盘差异、保留 CRLF，并拒绝过期读取", async () => {
    await writeFile(join(root, "main.ts"), "const value = 1;\r\nexport { value };\r\n");
    const original = await fsRead(root, "main.ts");
    const result = await fsPatch(root, "main.ts", "const value = 1;\n", "const value = 2;\n", {
      expectedHash: original.hash,
    });
    expect(await readFile(join(root, "main.ts"), "utf8")).toBe(
      "const value = 2;\r\nexport { value };\r\n",
    );
    expect(result.change).toMatchObject({
      additions: 1,
      deletions: 1,
      beforeHash: original.hash,
      truncated: false,
    });
    expect(result.change.diff).toContain("-const value = 1;\n+const value = 2;");
    await expect(
      fsWrite(root, "main.ts", "stale", { expectedHash: original.hash }),
    ).rejects.toThrow("重新 fs.read");
  });
  it("同一版本的并发编辑不会互相覆盖", async () => {
    await writeFile(join(root, "concurrent.ts"), "first\nsecond\n");
    const { hash } = await fsRead(root, "concurrent.ts");
    const results = await Promise.allSettled([
      fsPatch(root, "concurrent.ts", "first", "updated", { expectedHash: hash }),
      fsPatch(root, "concurrent.ts", "second", "overwritten", { expectedHash: hash }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    // 串行锁保证只有一个成功，但不保证数组顺序谁先执行。
    expect(["updated\nsecond\n", "first\noverwritten\n"]).toContain(
      await readFile(join(root, "concurrent.ts"), "utf8"),
    );
  });
  it("重复匹配默认拒绝，显式 replaceAll 才替换全部", async () => {
    await writeFile(join(root, "repeat.ts"), "same\nsame\n");
    await expect(fsPatch(root, "repeat.ts", "same", "next")).rejects.toThrow("2 处匹配");
    expect(await readFile(join(root, "repeat.ts"), "utf8")).toBe("same\nsame\n");
    expect(
      (await fsPatch(root, "repeat.ts", "same", "next", { replaceAll: true })).replacements,
    ).toBe(2);
  });
  it("新建文件使用空版本指纹，不能覆盖后来出现的文件", async () => {
    const result = await fsWrite(root, "nested/new.ts", "hello\n", { expectedHash: "" });
    expect(result.change).toMatchObject({
      operation: "create",
      additions: 1,
      deletions: 0,
      beforeHash: null,
    });
    await expect(fsWrite(root, "nested/new.ts", "replace", { expectedHash: "" })).rejects.toThrow(
      "文件在读取后已改变",
    );
  });
  it("阻止相对路径、跨盘路径与 junction 越界", async () => {
    expect(() => resolveUnderRoot(root, "../outside.txt")).toThrow("路径越界");
    if (process.platform === "win32")
      expect(() => resolveUnderRoot(root, "Z:/outside.txt")).toThrow("路径越界");
    const outside = join(area, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "untouched");
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(fsWrite(root, "linked/keep.txt", "bad")).rejects.toThrow("路径越界");
    await expect(fsRead(root, "linked/keep.txt")).rejects.toThrow("路径越界");
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("untouched");
  });
  it("默认搜索支持嵌套目录与花括号扩展名", async () => {
    await fsWrite(root, "nested/search.tsx", "needle-unique");
    expect(await fsGlob(root, "*.{ts,tsx}")).toContain("nested/search.tsx");
    expect(await fsSearch(root, "needle-unique")).toEqual([
      { path: "nested/search.tsx", line: 1, text: "needle-unique" },
    ]);
  });
  it("已取消操作不会写文件，拒绝二进制内容", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fsWrite(root, "cancelled.ts", "bad", { signal: controller.signal }),
    ).rejects.toThrow();
    await expect(readFile(join(root, "cancelled.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fsWrite(root, "binary", "a\0b")).rejects.toThrow("文本文件");
  });
  it("差异能区分末尾换行，统计不包含尾部空行", () => {
    expect(fileChange("a.ts", "a\nb\n", "a\nc\n")).toMatchObject({ additions: 1, deletions: 1 });
    expect(fileChange("a.ts", "a", "a\n").diff).toContain("\\ No newline at end of file");
    expect(fileChange("a.ts", "same\n", "same\n").diff).toBe("");
  });
});
