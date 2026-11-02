import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError, httpStatusOf, type Artifact } from "@agentdesk/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { EventHub } from "../src/events";
import { TaskService } from "../src/services/tasks";
import { artifactDownloadName, MAX_ARTIFACT_BYTES } from "../src/services/artifact-files";
import { artifactRoutes } from "../src/http/routes/tasks";

let handle: DbHandle | undefined;
let root: string | undefined;
afterEach(() => {
  handle?.close();
  handle = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function setup() {
  root = mkdtempSync(join(tmpdir(), "agentdesk-artifacts-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  handle = openDatabase(":memory:");
  const tasks = new TaskService(handle.db, new EventHub());
  const task = tasks.create({
    goal: "创建成果",
    conversationId: "conversation",
    requiresPlanApproval: false,
  });
  const run = tasks.createRun({
    taskId: task.id,
    kind: "root",
    agent: "code",
    trigger: "create",
    input: { userMessage: task.goal, workspace },
  });
  const record = (file: string, content: string | null = null) =>
    tasks.recordArtifact({
      taskId: task.id,
      runId: run.id,
      kind: "file",
      title: file,
      filePath: join(workspace, file),
      content,
    });
  return { tasks, task, run, workspace, record };
}

describe("成果版本与访问范围", () => {
  it("不同文件独立计版本，同一成果编辑保留旧版并拒绝陈旧保存", async () => {
    const { tasks, task, workspace, record } = setup();
    writeFileSync(join(workspace, "report.md"), "第一版");
    writeFileSync(join(workspace, "notes.md"), "另一份成果");
    const first = record("report.md", "第一版");
    const second = record("notes.md", "另一份成果");
    expect([first.version, second.version]).toEqual([1, 1]);
    const edited = await tasks.reviseArtifact(task.id, first.id, {
      baseVersion: 1,
      content: "第二版",
    });
    expect(edited.version).toBe(2);
    expect(edited.artifactKey).toBe(first.artifactKey);
    expect((await tasks.readArtifact(task.id, first.id)).content).toBe("第一版");
    expect((await tasks.readArtifact(task.id, edited.id)).content).toBe("第二版");
    expect(readFileSync(join(workspace, "report.md"), "utf8")).toBe("第一版");
    await expect(
      tasks.reviseArtifact(task.id, first.id, { baseVersion: 1, content: "旧客户端覆盖" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tasks.listArtifacts(task.id)).toHaveLength(3);
  });

  it("显式键让同类型报告各自留存版本", () => {
    const { tasks, task } = setup();
    const report = (artifactKey: string) =>
      tasks.recordArtifact({
        taskId: task.id,
        kind: "summary",
        title: "报告",
        content: "内容",
        artifactKey,
      });
    expect([
      report("design-review").version,
      report("code-review").version,
      report("design-review").version,
    ]).toEqual([1, 1, 2]);
  });

  it("拒绝跨任务读取、跨任务运行挂靠和越界文件", async () => {
    const { tasks, task, run, workspace, record } = setup();
    const other = tasks.create({
      goal: "其他任务",
      conversationId: "other",
      requiresPlanApproval: false,
    });
    writeFileSync(join(workspace, "report.md"), "报告");
    const artifact = record("report.md", "报告");
    await expect(tasks.readArtifact(other.id, artifact.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(() =>
      tasks.recordArtifact({ taskId: other.id, runId: run.id, title: "不合法", kind: "summary" }),
    ).toThrow(/不属于/);
    const outside = join(root!, "outside.txt");
    writeFileSync(outside, "private");
    const traversal = tasks.recordArtifact({
      taskId: task.id,
      runId: run.id,
      kind: "file",
      title: "越界",
      filePath: outside,
    });
    await expect(tasks.readArtifact(task.id, traversal.id)).rejects.toThrow(/不在任务项目目录/);
    const missingWorkspace = tasks.recordArtifact({
      taskId: task.id,
      kind: "file",
      title: "无工作区",
      filePath: join(workspace, "report.md"),
    });
    await expect(tasks.readArtifact(task.id, missingWorkspace.id)).rejects.toThrow(
      /没有绑定项目目录/,
    );
  });

  it("拒绝链接跳出工作区以及凭据目录", async () => {
    const { tasks, task, workspace, record } = setup();
    const outside = join(root!, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "private");
    symlinkSync(
      outside,
      join(workspace, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linked = record(join("linked", "secret.txt"));
    await expect(tasks.readArtifact(task.id, linked.id)).rejects.toThrow(/真实路径/);
    for (const file of [
      ".env",
      ".env.production",
      "private.key",
      join(".git", "config"),
      join(".aws", "credentials"),
    ]) {
      const artifact = record(file, "不可展示");
      await expect(tasks.readArtifact(task.id, artifact.id)).rejects.toThrow(/受保护/);
    }
  });

  it("历史快照与当前文件明确区分，源文件变化和删除不覆盖快照", async () => {
    const { tasks, task, workspace, record } = setup();
    const path = join(workspace, "report.md");
    writeFileSync(path, "v1");
    const snapshot = record("report.md", "v1");
    expect(await tasks.readArtifact(task.id, snapshot.id)).toMatchObject({
      source: "snapshot",
      content: "v1",
      changedOnDisk: false,
    });
    writeFileSync(path, "用户的磁盘修改");
    expect(await tasks.readArtifact(task.id, snapshot.id)).toMatchObject({
      content: "v1",
      changedOnDisk: true,
    });
    const live = record("report.md");
    expect(await tasks.readArtifact(task.id, live.id)).toMatchObject({
      source: "file",
      content: "用户的磁盘修改",
      changedOnDisk: null,
    });
    rmSync(path);
    expect(await tasks.readArtifact(task.id, snapshot.id)).toMatchObject({
      content: "v1",
      changedOnDisk: true,
    });
    await expect(tasks.readArtifact(task.id, live.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("图片保留字节，拒绝超大文件，Diff 独立预览", async () => {
    const { tasks, task, run, workspace, record } = setup();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64");
    writeFileSync(join(workspace, "preview.png"), png);
    const image = record("preview.png");
    const view = await tasks.readArtifact(task.id, image.id);
    expect(view).toMatchObject({ mimeType: "image/png", encoding: "base64", editable: false });
    expect(Buffer.from(view.content, "base64")).toEqual(png);
    writeFileSync(join(workspace, "large.txt"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
    const large = record("large.txt");
    await expect(tasks.readArtifact(task.id, large.id)).rejects.toThrow(/10 MB/);
    const diff = tasks.recordArtifact({
      taskId: task.id,
      runId: run.id,
      kind: "change",
      title: "变更",
      filePath: "report.md",
      content: "-before\n+after",
    });
    expect(await tasks.readArtifact(task.id, diff.id)).toMatchObject({
      source: "snapshot",
      mimeType: "text/plain",
      editable: false,
      content: "-before\n+after",
    });
    expect(artifactDownloadName(diff)).toBe("report.md.diff");
  });

  it("HTTP 返回下载附件并将版本冲突映射到 409", async () => {
    const { tasks, task, run } = setup();
    const first = tasks.recordArtifact({
      taskId: task.id,
      runId: run.id,
      kind: "summary",
      title: "审查报告",
      content: "# 初稿",
      artifactKey: "review",
    });
    const app = new Hono().route("/api", artifactRoutes(tasks));
    app.onError((error, c) =>
      error instanceof AppError
        ? c.json(error.toBody(), httpStatusOf(error.code) as 400)
        : c.json({ error: error.message }, 500),
    );
    const path = `/api/tasks/${task.id}/artifacts/${first.id}`;
    const downloaded = await app.request(`${path}/download`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("Content-Disposition")).toContain("attachment;");
    expect(downloaded.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await downloaded.text()).toBe("# 初稿");
    const edit = () =>
      app.request(`${path}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion: 1, content: "# 定稿" }),
      });
    const created = await edit();
    expect(created.status).toBe(201);
    expect(((await created.json()) as Artifact).version).toBe(2);
    expect((await edit()).status).toBe(409);
    expect((await app.request(`/api/tasks/other/artifacts/${first.id}/content`)).status).toBe(404);
  });
});
