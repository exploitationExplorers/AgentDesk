import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectInstructionService } from "../src/services/project-instructions";
import { repositoryGit } from "../src/services/remote/repository-git";

let fixture: string;
let projectA: string;
let projectB: string;
let service: ProjectInstructionService;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "agentdesk-instructions-"));
  projectA = join(fixture, "a");
  projectB = join(fixture, "b");
  await Promise.all([mkdir(projectA), mkdir(projectB)]);
  service = new ProjectInstructionService({ list: () => [{ path: projectA }, { path: projectB }] });
});

describe("项目指令", () => {
  it("同时加载项目时不混入其他项目或父级规则，每次运行读取最新内容", async () => {
    await Promise.all([
      writeFile(join(fixture, "AGENTS.md"), "parent-rule"),
      writeFile(join(projectA, "AGENTS.md"), "project-a-rule"),
      writeFile(join(projectA, "CLAUDE.md"), "project-a-claude"),
      writeFile(join(projectB, "AGENTS.md"), "project-b-rule"),
    ]);
    const [a, b] = await Promise.all([service.load(projectA), service.load(projectB)]);
    expect(a).toContain("project-a-rule");
    expect(a).toContain("project-a-claude");
    expect(a).toContain(join(projectA, "AGENTS.md"));
    expect(a).not.toContain("project-b-rule");
    expect(a).not.toContain("parent-rule");
    expect(b).toContain("project-b-rule");
    expect(b).not.toContain("project-a-rule");
    await writeFile(join(projectA, "AGENTS.md"), "updated-rule");
    expect(await service.load(projectA)).toContain("updated-rule");
    expect(await service.load()).toBeUndefined();
  });

  it("项目级与本地指令从各自 checkout 加载，工作区记忆只在真实 worktree 间共享", async () => {
    await repositoryGit(projectA, ["init", "--quiet"]);
    await repositoryGit(projectA, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Fixture",
    ]);
    const linked = join(fixture, "linked");
    await repositoryGit(projectA, ["worktree", "add", "--detach", linked]);
    const registered = new ProjectInstructionService({
      list: () => [{ path: projectA }, { path: projectB }, { path: linked }],
    });
    await mkdir(join(linked, ".claude"));
    await writeFile(join(linked, ".claude", "CLAUDE.md"), "team-instructions");
    await writeFile(join(linked, "CLAUDE.local.md"), "local-instructions");
    expect(await registered.load(linked)).toContain("team-instructions");
    expect(await registered.load(linked)).toContain("local-instructions");
    expect(await registered.load(projectA)).not.toContain("local-instructions");
    expect(await registered.memoryRoot(linked)).toBe(projectA);
    expect(await registered.memoryRoot(projectA)).toBe(projectA);

    await repositoryGit(projectA, ["clone", "--local", ".", projectB]);
    expect(await registered.memoryRoot(projectB)).toBe(projectB);
    const alias = join(fixture, "alias");
    await mkdir(alias);
    const marker = await readFile(join(linked, ".git"), "utf8");
    await writeFile(join(alias, ".git"), marker);
    const aliased = new ProjectInstructionService({ list: () => [{ path: alias }] });
    expect(await aliased.memoryRoot(alias)).toBe(alias);
  });

  it("拒绝未注册目录、注册目录内的子目录和相对路径", async () => {
    await expect(service.load(fixture)).rejects.toThrow("未登记");
    await expect(service.load(join(projectA, "src"))).rejects.toThrow("未登记");
    await expect(service.load("a")).rejects.toThrow("绝对路径");
  });

  it("指令不存在可继续，但目录、过大或非文本指令必须明确失败", async () => {
    expect(await service.load(projectA)).toContain(projectA);
    await mkdir(join(projectA, "AGENTS.md"));
    await expect(service.load(projectA)).rejects.toThrow("无法加载项目指令");
    await writeFile(join(projectB, "CLAUDE.md"), "x".repeat(32 * 1024 + 1));
    await expect(service.load(projectB)).rejects.toThrow("32 KiB");
    await writeFile(join(projectB, "CLAUDE.md"), Buffer.from([0, 1]));
    await expect(service.load(projectB)).rejects.toThrow("二进制");
  });

  it("指令文件经 junction 指向项目外时拒绝，不读取外部内容", async () => {
    await symlink(projectB, join(projectA, "AGENTS.md"), "junction");
    await expect(service.load(projectA)).rejects.toThrow("项目根之外");
  });

  it("已取消的运行不继续读取规则", async () => {
    const controller = new AbortController();
    controller.abort(new Error("停止加载"));
    await expect(service.load(projectA, controller.signal)).rejects.toThrow("停止加载");
  });
});
