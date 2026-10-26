import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { copyPublicSkills } from "../scripts/public-skills";
import { createAgentDefinitions } from "../src/agents/definitions";
import { loadConfig, loadEnvFiles } from "../src/config";
import { createContainer, type Container } from "../src/container";
import { createApp } from "../src/http/app";

const root = mkdtempSync(join(tmpdir(), "agentdesk-wechat-test-"));
const skillsDir = join(root, "skills");
const dataDir = join(root, "data");
let container: Container | undefined;

function writeSkill(base: string, directory: string, name = directory): void {
  const dir = join(base, directory);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill\ntriggers: [日报]\n---\nTest instructions`,
  );
}

for (const name of [
  "bt-deploy",
  "project-triage",
  "tech-explain",
  "wechat-daily-report",
  "personal-skill",
]) {
  writeSkill(skillsDir, name);
}
// 数据目录和改名后的包也必须受开关控制。
writeSkill(join(dataDir, "skills"), "renamed-private-skill", "wechat-daily-report");

afterEach(async () => {
  vi.unstubAllEnvs();
  await container?.dispose();
  container = undefined;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function config(enabled?: string) {
  return loadConfig({
    AGENTDESK_DATA_DIR: dataDir,
    AGENTDESK_SKILLS_DIR: skillsDir,
    AGENTDESK_WECHAT_REPORT_ENABLED: enabled,
  });
}

describe("微信日报功能开关", () => {
  it.each([undefined, "false", "0", "1", "TRUE", ""])("配置为 %s 时默认关闭", (value) => {
    expect(config(value).wechatReportEnabled).toBe(false);
  });

  it("从 .env 读取显式开启值，已有环境变量优先", () => {
    const file = join(root, ".env");
    writeFileSync(file, "AGENTDESK_WECHAT_REPORT_ENABLED=true\n");
    vi.stubEnv("AGENTDESK_WECHAT_REPORT_ENABLED", undefined);
    loadEnvFiles([join(root, "missing.env"), file]);
    expect(loadConfig({ ...process.env, AGENTDESK_DATA_DIR: dataDir }).wechatReportEnabled).toBe(
      true,
    );
    vi.stubEnv("AGENTDESK_WECHAT_REPORT_ENABLED", "false");
    loadEnvFiles([file]);
    expect(loadConfig({ ...process.env, AGENTDESK_DATA_DIR: dataDir }).wechatReportEnabled).toBe(
      false,
    );
  });

  it("关闭时隐藏私有 skill，所有微信 API 均不可访问", async () => {
    container = await createContainer(config(), { inMemory: true });
    const app = createApp(container);
    expect(container.wechat).toBeNull();
    expect(container.skills.get("wechat-daily-report")).toBeUndefined();
    expect(container.skills.promptFor("code", "日报")).not.toContain("wechat-daily-report");
    const skills = await (await app.request("/api/skills")).json();
    expect(skills.some((s: { name: string }) => s.name === "wechat-daily-report")).toBe(false);
    expect(skills.some((s: { name: string }) => s.name === "tech-explain")).toBe(true);
    for (const [path, method] of [
      ["status", "GET"],
      ["decrypt", "POST"],
      ["groups", "GET"],
      ["reports", "GET"],
      ["reports", "POST"],
      ["reports/id", "GET"],
      ["reports/id/image", "GET"],
    ]) {
      const response = await app.request(`/api/skills/wechat/${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    const load = container.skills.createLoadTool();
    await expect(
      load.execute(
        { name: "wechat-daily-report" },
        {
          agent: "code",
          emit: () => {},
          requestApproval: async () => false,
        },
      ),
    ).rejects.toThrow("技能不存在");
    expect(JSON.stringify(createAgentDefinitions(false))).not.toContain(
      "skills.load wechat-daily-report",
    );
  });

  it("显式开启且安装私有包后恢复入口和服务", async () => {
    container = await createContainer(config("true"), { inMemory: true });
    expect(container.wechat).not.toBeNull();
    expect(container.skills.get("wechat-daily-report")).toBeDefined();
    const response = await createApp(container).request("/api/skills/wechat/reports");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(JSON.stringify(createAgentDefinitions(true))).toContain(
      "skills.load wechat-daily-report",
    );
  });

  it("开启但缺少私有包时仍可启动，调用时返回明确错误", async () => {
    const empty = join(root, "empty");
    container = await createContainer(
      { ...config("true"), skillDirs: [empty] },
      { inMemory: true },
    );
    const response = await createApp(container).request("/api/skills/wechat/status");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("私有技能");
  });
});

it("公开构建只复制公开技能，不复制私有包、环境文件和解密数据", () => {
  writeFileSync(join(skillsDir, ".env"), "PRIVATE_CONFIG=local\n");
  const privateDir = join(skillsDir, "wechat-daily-report", "decrypted");
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, "contact.db"), "private data");
  const destination = join(root, "public-skills");
  copyPublicSkills(skillsDir, destination);
  expect(readdirSync(destination).sort()).toEqual(["bt-deploy", "project-triage", "tech-explain"]);
});
