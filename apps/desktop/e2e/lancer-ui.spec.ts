import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { discussionDemo } from "../scripts/readme-team-fixtures";
import { responses } from "../scripts/readme-fixtures";

const lightModule = `/@fs/${fileURLToPath(new URL("../../../packages/light-ui/src/index.ts", import.meta.url)).replaceAll("\\", "/")}`;

test("群聊长文、中文加粗与代码对比度在浅色、深色和手机中可读", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const detail = structuredClone(discussionDemo);
  const message = detail.messages.at(-1)!;
  detail.messages = [message];
  message.content = [
    "## 需要统一的结论边界",
    "- **旧凭证被写回，不等于完整恢复登录态。** 应分别核对界面账号、内存状态、存储凭证与实际请求身份。",
    "- **续期路径需要独立验证。** 延迟回调、退出登录与切换账号都要纳入检查。",
    "## 建议的验证顺序",
    "1. **凭证竞态： **延迟 A 账号的存储回调，退出或切换 B 后再释放，检查最终凭证与请求身份。",
    "2. **资料竞态： **延迟 A 的资料响应，切换 B 后释放，检查是否覆盖 B 的资料。",
    "3. **数量边界： **准备 101 条记录，重新同步，分别检查展示与消息拦截。",
    "工作区为 `codex/native-bootstrap`。**常规加粗**，仍按原样显示。",
    "字面量：\\*\\*保留字面量： \\*\\*",
    "```text\n**代码内保留： **\n```",
    "供你决定：建议先核对以上流程，再确认修改范围。".repeat(4),
  ].join("\n\n");
  await page.addInitScript(() => {
    localStorage.setItem("agentdesk.diskNagUntil", String(Date.now() + 86400000));
    localStorage.setItem("agentdesk-ui", JSON.stringify({ state: { theme: "light" }, version: 0 }));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    const data: Record<string, unknown> = {
      ...responses,
      "/collaboration/sources": { agents: [], providers: [] },
      "/collaboration/members": detail.members,
      "/collaboration/rooms": [detail.room],
      "/collaboration/rooms/demo-discussion": detail,
    };
    if (path === "/events")
      return route.fulfill({ contentType: "text/event-stream", body: ": test\n\n" });
    return route.fulfill({ json: data[path] ?? [] });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/#/collaboration?room=demo-discussion");
  const bubble = page.locator(".cc-bubble");
  await expect(bubble.locator("ol li strong").first()).toHaveText("凭证竞态：");
  await expect(bubble.locator("pre code")).toHaveText("**代码内保留： **\n");
  await expect(bubble).toContainText("**保留字面量： **");
  await expect(bubble.locator("strong").filter({ hasText: "常规加粗" })).toBeVisible();
  const code = bubble.locator("p > code");
  await expect(code).toHaveCSS("color", "rgb(69, 65, 83)");
  await expect(code).toHaveCSS("background-color", "rgb(229, 229, 235)");
  expect(
    await bubble.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(820);
  await page.screenshot({ path: testInfo.outputPath("collaboration-reading.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(code).toHaveCSS("color", "rgb(69, 65, 83)");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("collaboration-reading-mobile.png") });
  message.status = "streaming";
  await page.reload();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".light-running-border rect")).toHaveCSS("animation-name", "none");
  expect(errors).toEqual([]);
});

test("独立光线层支持取消、暂停、缺失锚点、减少动态效果与销毁", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async (module) => {
    const { createLightLayer } = await import(module);
    const host = document.createElement("div");
    Object.assign(host.style, { position: "fixed", inset: "10px", zIndex: "10000" });
    document.body.append(host);
    const layer = createLightLayer(host);
    layer.pause();
    const source = { x: 30, y: 30 },
      target = { x: 300, y: 160 };
    const flight = layer.emit({ id: "cancel", source, target, color: "#9077bd" });
    const paused = layer.paused;
    flight.cancel();
    const cancelled = await flight.finished;
    layer.resume();
    const missing = await layer.emit({
      id: "missing",
      source: () => null,
      target,
      color: "#9077bd",
    }).finished;
    const pending = layer.emit({ id: "destroy", source, target, color: "#9077bd" });
    layer.destroy();
    const destroyed = await pending.finished;
    const overlays = host.querySelectorAll("[data-light-layer]").length;
    host.remove();
    return { paused, cancelled, missing, destroyed, overlays };
  }, lightModule);
  expect(result).toEqual({
    paused: true,
    cancelled: "cancelled",
    missing: "missing-anchor",
    destroyed: "cancelled",
    overlays: 0,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page.evaluate(async (module) => {
      const { createLightLayer } = await import(module);
      const layer = createLightLayer();
      const result = await layer.emit({
        id: "reduced",
        source: { x: 10, y: 10 },
        target: { x: 200, y: 200 },
        color: "#9077bd",
      }).finished;
      layer.destroy();
      return result;
    }, lightModule),
  ).toBe("arrived");
});
