import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Artifact, Task } from "@agentdesk/shared";

const task: Task = {
  id: "artifact-task",
  title: "整理项目分析报告",
  goal: "生成报告并保留成果版本",
  agent: "code",
  conversationId: "artifact-conversation",
  requiresPlanApproval: false,
  status: "awaiting_review",
  currentRunId: null,
  pendingApprovalId: null,
  createdAt: "2026-11-02T08:00:00Z",
  updatedAt: "2026-11-02T08:00:00Z",
  closedAt: null,
};

const report: Artifact = {
  id: "report-v1",
  taskId: task.id,
  runId: "artifact-run",
  kind: "summary",
  version: 1,
  title: "分析报告",
  content: "# 初稿报告\n\n需要核对项目入口。",
  filePath: null,
  mimeType: "text/markdown",
  metadata: null,
  artifactKey: "report",
  createdAt: task.createdAt,
};

async function fixture(page: Page, initial: Artifact[], cli = false) {
  const artifacts = [...initial];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/cli-monitor", "/api");
    if (path === "/api/tasks") return route.fulfill({ json: [task] });
    if (path === "/api/approvals" || path === `/api/tasks/${task.id}/runs`)
      return route.fulfill({ json: [] });
    if (path === `/api/tasks/${task.id}/stream`)
      return route.fulfill({ contentType: "text/event-stream", body: ": connected\n\n" });
    if (path === `/api/tasks/${task.id}/artifacts`) return route.fulfill({ json: artifacts });
    const match = path.match(/\/artifacts\/([^/]+)\/(content|download|versions)$/);
    if (!match) return route.continue();
    const artifact = artifacts.find((item) => item.id === match[1])!;
    if (match[2] === "content")
      return route.fulfill({
        json: {
          artifact,
          content: artifact.content,
          mimeType: artifact.mimeType,
          encoding: "utf8",
          source: "snapshot",
          editable: true,
          changedOnDisk: false,
        },
      });
    if (match[2] === "download")
      return route.fulfill({
        body: artifact.content!,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": "attachment; filename=report.md",
        },
      });
    expect(cli).toBe(false);
    const input = route.request().postDataJSON() as { baseVersion: number; content: string };
    expect(input.baseVersion).toBe(artifact.version);
    const revised: Artifact = { ...artifact, id: "report-v2", version: 2, content: input.content };
    artifacts.push(revised);
    return route.fulfill({ status: 201, json: revised });
  });
  await page.goto(`/#/code?task=${task.id}${cli ? "&source=cli" : ""}`);
  await page.getByRole("button", { name: "成果", exact: true }).click();
  await expect(page.getByRole("region", { name: "成果工作区" })).toBeVisible();
  return artifacts;
}

test("成果支持编辑新版本、保留初稿、版本对比和附件下载", async ({ page }) => {
  const artifacts = await fixture(page, [report]);
  const workspace = page.getByRole("region", { name: "成果工作区" });
  await expect(workspace.getByRole("heading", { name: "初稿报告" })).toBeVisible();
  await workspace.getByRole("button", { name: "编辑成果" }).click();
  await workspace.getByRole("textbox", { name: "成果正文" }).fill("# 定稿报告\n\n已核对项目入口。");
  await workspace.getByRole("button", { name: "保存新版本" }).click();
  await expect(workspace.getByRole("heading", { name: "定稿报告" })).toBeVisible();
  expect(artifacts).toHaveLength(2);
  expect(artifacts[0]?.content).toContain("初稿报告");
  await workspace.getByRole("button", { name: "对比上一版本" }).click();
  await expect(workspace.getByText("上一版本 v1", { exact: true })).toBeVisible();
  await expect(workspace.getByText("当前版本 v2", { exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "关闭版本对比" }).click();
  await workspace.getByRole("combobox", { name: "成果版本" }).selectOption("report-v1");
  await expect(workspace.getByRole("heading", { name: "初稿报告" })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "编辑成果" })).toHaveCount(0);
  await workspace.getByRole("combobox", { name: "成果版本" }).selectOption("report-v2");
  const downloaded = page.waitForEvent("download");
  await workspace.getByRole("link", { name: "下载成果" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("report.md");
  expect(await readFile((await download.path())!, "utf8")).toContain("定稿报告");
  await page.setViewportSize({ width: 980, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("HTML 预览隔离脚本、表单和外部资源", async ({ page }) => {
  let externalRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("artifact-invalid.example")) externalRequests += 1;
  });
  await fixture(page, [
    {
      ...report,
      id: "html-v1",
      artifactKey: "html",
      mimeType: "text/html",
      content:
        '<head><style>h1 { color: rgb(10, 20, 30); }</style></head><body><h1>静态成果</h1><script>parent.document.body.dataset.artifactAttack="executed"</script><img src="https://artifact-invalid.example/leak"><form action="https://artifact-invalid.example/submit"><button>发送</button></form><iframe src="https://artifact-invalid.example/frame"></iframe><a href="https://artifact-invalid.example/link">外链</a></body>',
    },
  ]);
  const iframe = page.locator('iframe[title="HTML 成果预览"]');
  await expect(iframe).toHaveAttribute("sandbox", "");
  const preview = iframe.contentFrame();
  await expect(preview.getByRole("heading", { name: "静态成果" })).toBeVisible();
  await expect(preview.getByRole("heading", { name: "静态成果" })).toHaveCSS(
    "color",
    "rgb(10, 20, 30)",
  );
  await expect(preview.locator("script, form, iframe")).toHaveCount(0);
  await expect(preview.locator("img")).not.toHaveAttribute("src");
  await expect(preview.locator("a")).not.toHaveAttribute("href");
  expect(await page.evaluate(() => document.body.dataset.artifactAttack)).toBeUndefined();
  expect(externalRequests).toBe(0);
});

test("CLI 成果可以查看和下载，编辑入口保持只读", async ({ page }) => {
  await fixture(page, [report], true);
  const workspace = page.getByRole("region", { name: "成果工作区" });
  await expect(workspace.getByRole("heading", { name: "初稿报告" })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "编辑成果" })).toHaveCount(0);
  await expect(workspace.getByRole("link", { name: "下载成果" })).toHaveAttribute(
    "href",
    /\/cli-monitor\/tasks\/artifact-task\/artifacts\/report-v1\/download/,
  );
});
