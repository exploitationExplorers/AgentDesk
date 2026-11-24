import { expect, test, type Page } from "@playwright/test";
import type {
  DiskCandidate,
  DiskCleanCommitRequest,
  DiskScan,
  DiskStatus,
  DiskVolume,
} from "@agentdesk/shared";

const GB = 1024 ** 3;
const volumes: DiskVolume[] = [
  {
    volumePath: "C:\\",
    label: "Windows",
    isHome: true,
    totalBytes: 300 * GB,
    freeBytes: 80 * GB,
    usedBytes: 220 * GB,
    thresholdBytes: 15 * GB,
    low: false,
  },
  {
    volumePath: "D:\\",
    label: "Data",
    isHome: false,
    totalBytes: 600 * GB,
    freeBytes: 8 * GB,
    usedBytes: 592 * GB,
    thresholdBytes: 15 * GB,
    low: true,
  },
  {
    volumePath: "F:\\",
    label: "Backup",
    isHome: false,
    totalBytes: 200 * GB,
    freeBytes: 90 * GB,
    usedBytes: 110 * GB,
    thresholdBytes: 15 * GB,
    low: false,
  },
];
const status: DiskStatus = { ...volumes[1]!, platform: "win32", volumes };

async function mockDisks(page: Page, silence = true) {
  if (silence)
    await page.addInitScript(() =>
      localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000)),
    );
  let current: DiskScan | null = null;
  const scans: string[] = [];
  const cleaned: DiskCleanCommitRequest[] = [];
  await page.route("**/api/disk/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) return route.fulfill({ json: status });
    if (path.endsWith("/scan") && route.request().method() === "GET")
      return route.fulfill({ json: current });
    if (path.endsWith("/scan")) {
      const { volumePath } = route.request().postDataJSON() as { volumePath: string };
      scans.push(volumePath);
      const volume = volumes.find((entry) => entry.volumePath === volumePath)!;
      const item: DiskCandidate = {
        id: "d001",
        title: volumePath === "D:\\" ? "movie.mp4" : "缓存",
        path: `${volumePath}Downloads\\movie.mp4`,
        bytes: 12 * GB,
        tier: volumePath === "D:\\" ? "optional" : "primary",
        category: "user",
        reason: "确认不再需要后再清理",
        mode: "whole",
        regenerable: volumePath !== "D:\\",
        protected: false,
        selectable: true,
        daysSinceUsed: 45,
        truncated: false,
      };
      current = {
        id: `scan-${volumePath}`,
        scannedAt: new Date().toISOString(),
        status: { ...status, ...volume },
        summary: `${volumePath} 的扫描结果`,
        items: [item],
        usage: [
          {
            path: `${volumePath}Downloads`,
            title: "Downloads",
            bytes: 12 * GB,
            truncated: false,
            kind: "directory",
          },
        ],
        primaryBytes: item.tier === "primary" ? item.bytes : 0,
        optionalBytes: item.tier === "optional" ? item.bytes : 0,
        partial: false,
      };
      return route.fulfill({ json: current });
    }
    if (path.endsWith("/inspect")) {
      const { path: directory } = route.request().postDataJSON() as { path: string };
      return route.fulfill({
        json: {
          path: directory,
          partial: true,
          usage: [
            {
              path: `${directory}\\movie.mp4`,
              title: "movie.mp4",
              bytes: 12 * GB,
              kind: "file",
              truncated: false,
            },
          ],
        },
      });
    }
    if (path.endsWith("/plan")) {
      const item = current!.items[0]!;
      return route.fulfill({
        json: {
          token: "fixture-plan",
          volumePath: current!.status.volumePath,
          items: [
            {
              id: item.id,
              path: item.path,
              title: item.title,
              mode: item.mode,
              bytes: item.bytes,
              action: "trash",
            },
          ],
          skipped: [],
        },
      });
    }
    if (path.endsWith("/clean")) {
      cleaned.push(route.request().postDataJSON());
      current = current && {
        ...current,
        items: current.items.map((item) => ({
          ...item,
          bytes: 0,
          tier: "keep",
          selectable: false,
        })),
        primaryBytes: 0,
        optionalBytes: 0,
      };
      return route.fulfill({
        json: {
          freedBytes: 0,
          freeBytesBefore: 8 * GB,
          freeBytesAfter: 8 * GB,
          cleaned: [
            { id: "d001", path: "D:\\Downloads\\movie.mp4", bytes: 12 * GB, action: "trash" },
          ],
          skipped: [],
        },
      });
    }
    return route.continue();
  });
  return { scans, cleaned };
}

test("按实际磁盘选择扫描，切盘清除旧选择，用户文件不默认勾选", async ({ page }) => {
  const { scans, cleaned } = await mockDisks(page);
  await page.goto("/#/disk");
  await expect(page.getByRole("button", { name: /D:\\ Data/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: /F:\\ Backup/ })).toBeVisible();
  await page.getByRole("button", { name: "扫描", exact: true }).click();
  await expect(page.getByText("D:\\ 的扫描结果", { exact: true })).toBeVisible();
  expect(scans).toEqual(["D:\\"]);
  await expect(page.getByRole("button", { name: "预览清理", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "主要空间占用" })).toBeVisible();
  await page.getByRole("button", { name: "打开 Downloads · 12.0 GB", exact: true }).click();
  await expect(page.getByRole("list", { name: "按大小排列的文件和目录" })).toContainText(
    "movie.mp4",
  );
  await expect(page.getByText("部分路径因权限、保护规则或扫描上限未统计。")).toBeVisible();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(page.getByRole("button", { name: /打开 Downloads/ })).toBeVisible();
  await page.getByRole("button", { name: /C:\\ Windows/ }).click();
  await expect(page.getByText("D:\\ 的扫描结果", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "扫描", exact: true }).click();
  await expect(page.getByRole("button", { name: "预览清理", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /D:\\ Data/ }).click();
  await expect(page.getByRole("button", { name: "预览清理", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "扫描", exact: true }).click();
  await expect(page.getByText("D:\\ 的扫描结果", { exact: true })).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "预览清理", exact: true }).click();
  const plan = page.getByRole("dialog", { name: "确认清理清单" });
  await expect(plan).toContainText("D:\\Downloads\\movie.mp4");
  await expect(plan).toContainText("移入回收站");
  expect(cleaned).toEqual([]);
  await plan.getByRole("button", { name: "返回", exact: true }).click();
  await expect(plan).toBeHidden();
  expect(cleaned).toEqual([]);
  await page.getByRole("button", { name: "预览清理", exact: true }).click();
  await plan.getByRole("button", { name: "确认清理", exact: true }).click();
  await expect(page.getByRole("heading", { name: "清理结果" })).toBeVisible();
  expect(cleaned).toEqual([{ scanId: "scan-D:\\", ids: ["d001"], planToken: "fixture-plan" }]);
  await expect(page.getByText(/清理前 8.0 GB · 清理后 8.0 GB/)).toBeVisible();
  await expect(page.getByText(/移入回收站的文件需清空回收站后才释放空间/)).toBeVisible();
  await expect(page.getByRole("button", { name: "预览清理", exact: true })).toBeDisabled();
  await page.getByRole("heading", { name: "磁盘清理", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "../../.workflow/.scratchpad/disk-multivolume.png",
    fullPage: true,
  });
});

test("低空间提醒显示具体磁盘并直接扫描该盘", async ({ page }) => {
  const { scans } = await mockDisks(page, false);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /D:\\ 只剩/ })).toBeVisible();
  await page.getByRole("button", { name: "帮我看看", exact: true }).click();
  await expect(page.getByText("D:\\ 的扫描结果", { exact: true })).toBeVisible();
  expect(scans).toEqual(["D:\\"]);
});

test("Bot 清理审批显示每个目标的路径与处理方式", async ({ page }) => {
  await mockDisks(page);
  await page.route("**/api/approvals?*", (route) =>
    route.fulfill({
      json: [
        {
          id: "disk-approval",
          kind: "tool",
          title: "清理磁盘 D:\\",
          detail:
            "- 永久删除目录内容 · 1 GB · D:\\Cache\n- 移入回收站 · 2 GB · D:\\Downloads\\archive.zip",
          risk: "confirm",
          payload: {
            tool: "disk.clean",
            args: { scanId: "disk-scan", ids: ["d001", "d002"], planToken: "fixture-plan" },
          },
          status: "pending",
          createdAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ],
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/disk");
  await expect(page.getByText(/永久删除目录内容 · 1 GB · D:\\Cache/)).toContainText(
    "D:\\Downloads\\archive.zip",
  );
  await expect(page.getByText("fixture-plan", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "批准执行" })).toBeVisible();
});
