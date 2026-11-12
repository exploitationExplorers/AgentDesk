import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { SecretStore } from "../src/secrets";
import {
  CloudRepositorySetup,
  approvedRepositoryUrl,
} from "../src/services/remote/repository-setup";
import type { ProjectService } from "../src/services/projects";
import type * as RepositoryGit from "../src/services/remote/repository-git";
const transport = vi.hoisted(() => ({ remote: "", clones: 0, fail: false }));
vi.mock("../src/services/remote/repository-git", async (original) => {
  const actual = await original<typeof RepositoryGit>();
  return {
    ...actual,
    repositoryGit: async (
      cwd: string,
      args: string[],
      options: Parameters<typeof actual.repositoryGit>[2],
    ) => {
      if (args.includes("clone")) {
        transport.clones++;
        if (transport.fail) throw new Error("connection lost");
        args = args.map((arg) =>
          arg === "https://github.com/owner/repository.git" ? transport.remote : arg,
        );
      }
      return actual.repositoryGit(cwd, args, options);
    },
  };
});
let root: string, handle: DbHandle, service: CloudRepositorySetup, secrets: SecretStore;
const input = {
  clientRequestId: "import-1",
  url: "https://github.com/owner/repository",
  name: "Test Owner",
  email: "test@example.invalid",
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentdesk-repo-setup-"));
  const source = join(root, "source"),
    workspaces = join(root, "workspaces");
  mkdirSync(source);
  mkdirSync(workspaces);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(source, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "test: fixture");
  transport.remote = source;
  transport.clones = 0;
  transport.fail = false;
  handle = openDatabase(":memory:");
  secrets = new SecretStore(handle.db, randomBytes(32).toString("base64"), root);
  service = new CloudRepositorySetup(
    handle.raw,
    secrets,
    {
      add: vi.fn(async (path: string) => {
        expect(path.startsWith(workspaces)).toBe(true);
        return { id: "project-1" };
      }),
    } as unknown as ProjectService,
    root,
    workspaces,
  );
});
afterEach(async () => {
  await service.dispose();
  handle.close();
  rmSync(root, { recursive: true, force: true });
});
it("rejects credentials in URLs, private hosts, query strings, non-HTTPS and traversal", () => {
  for (const url of [
    "http://github.com/a/b",
    "https://127.0.0.1/a/b",
    "https://token@github.com/a/b",
    "https://github.com/a/b?x=y",
    "https://github.com/a/%2e%2e/secrets",
    "file:///tmp/repo",
  ])
    expect(() => approvedRepositoryUrl(url)).toThrow();
  expect(approvedRepositoryUrl(input.url)).toBe("https://github.com/owner/repository.git");
});
it("encrypts tokens and exposes only credential presence, scoped to the exact repository", () => {
  expect(
    service.credentials({ url: input.url, username: "owner", token: "test-secret-token" }),
  ).toEqual({ url: input.url + ".git", hasToken: true });
  expect(JSON.stringify(handle.raw.prepare("SELECT * FROM secrets").all())).not.toContain(
    "test-secret-token",
  );
  expect(service.gitConfig("https://github.com/other/repo.git")).toEqual({});
  expect(service.gitConfig(input.url)).toHaveProperty(`http.${input.url}.git.extraHeader`);
});
it("clones once after repeated submissions, registers only the completed checkout, and persists identity", async () => {
  const first = await service.begin(input);
  expect((await service.begin(input)).id).toBe(first.id);
  await service.dispose();
  expect(await service.get(first.id)).toMatchObject({
    status: "succeeded",
    projectId: "project-1",
  });
  expect(transport.clones).toBe(1);
  const cwd = join(root, "workspaces", `cloud-${first.id}`);
  expect(execFileSync("git", ["config", "user.email"], { cwd, encoding: "utf8" }).trim()).toBe(
    input.email,
  );
  await expect(service.begin({ ...input, name: "Changed" })).rejects.toThrow("请求编号");
});
it("preserves failed operations and does not retry a clone after a lost response", async () => {
  transport.fail = true;
  const first = await service.begin(input);
  await service.dispose();
  expect((await service.get(first.id)).status).toBe("failed");
  expect((await service.begin(input)).id).toBe(first.id);
  expect(transport.clones).toBe(1);
});
