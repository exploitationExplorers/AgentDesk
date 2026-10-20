import { describe, expect, it } from "vitest";
import {
  buildBackendDeploySteps,
  candidateFromCcProvider,
  candidatesFromDotenv,
  classifyFeedItem,
  encodeClaudeProjectPath,
  maskSecret,
  parseDotenv,
  parseGithubTrending,
  parseRemote,
} from "../src";

describe("parseRemote", () => {
  it.each([
    ["https://github.com/badlogic/pi-mono.git", "github", "badlogic", "pi-mono"],
    ["git@gitee.com:me/im-server.git", "gitee", "me", "im-server"],
    ["ssh://git@gitlab.corp.com:2222/team/sub/app.git", "gitlab", "team/sub", "app"],
  ])("%s", (url, platform, owner, repo) => {
    expect(parseRemote(url)).toMatchObject({ platform, owner, repo });
  });

  it("识别自建 GitLab 域名", () => {
    expect(parseRemote("https://code.company.cn/a/b.git", ["code.company.cn"])?.platform).toBe(
      "gitlab",
    );
    expect(parseRemote("https://code.company.cn/a/b.git")?.platform).toBe("unknown");
  });
});

describe("dotenv importer", () => {
  const env = parseDotenv(`
# comment
OPENAI_API_KEY="sk-aaaaaaaaaaaaaaaa"
OPENAI_BASE_URL=https://relay.example.com/v1
OPENAI_MODEL=gpt-4o-mini
LANGSMITH_API_KEY=lsv2_xxxxxxxxxxxxxxxx
ANTHROPIC_AUTH_TOKEN=sk-ant-bbbbbbbbbbbb # inline
UNKNOWN_API_KEY=zzzzzzzzzzzz
`);

  it("解析引号与行内注释", () => {
    expect(env.OPENAI_API_KEY).toBe("sk-aaaaaaaaaaaaaaaa");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-bbbbbbbbbbbb");
  });

  it("识别 LLM key，跳过 LangSmith 和无地址的未知前缀", () => {
    const candidates = candidatesFromDotenv(env, "test.env");
    expect(candidates.map((c) => c.name).sort()).toEqual(["Anthropic", "OpenAI"]);
    const openai = candidates.find((c) => c.name === "OpenAI")!;
    expect(openai.baseUrl).toBe("https://relay.example.com/v1");
    expect(openai.model).toBe("gpt-4o-mini");
    expect(candidates.find((c) => c.name === "Anthropic")?.api).toBe("anthropic-messages");
  });

  it("掩码不泄露完整 key", () => {
    expect(maskSecret("sk-1234567890abcdef")).toBe("sk-1****cdef");
  });
});

describe("cc-switch importer", () => {
  it("Claude 中转站", () => {
    const c = candidateFromCcProvider(
      {
        id: "p1",
        name: "Relay",
        appType: "claude",
        settingsConfig: {
          env: { ANTHROPIC_AUTH_TOKEN: "tok-123456789", ANTHROPIC_BASE_URL: "https://relay.cc" },
        },
      },
      "config.json",
    );
    expect(c).toMatchObject({ api: "anthropic-messages", baseUrl: "https://relay.cc" });
  });

  it("Codex 配置解析 toml base_url", () => {
    const c = candidateFromCcProvider(
      {
        id: "p2",
        name: "Codex Relay",
        appType: "codex",
        settingsConfig: JSON.stringify({
          auth: { OPENAI_API_KEY: "sk-codex-123456" },
          config: 'model = "gpt-5"\n[model_providers.x]\nbase_url = "https://codex.relay/v1"',
        }),
      },
      "db",
    );
    expect(c).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://codex.relay/v1",
      model: "gpt-5",
    });
  });
});

describe("feed", () => {
  it("解析 GitHub Trending HTML", () => {
    const html = `
      <article class="Box-row">
        <h2><a href="/owner/cool-agent"> owner / cool-agent </a></h2>
        <p> An LLM agent framework </p>
        <span itemprop="programmingLanguage">TypeScript</span>
        <a href="/owner/cool-agent/stargazers">12,345</a>
        <span class="d-inline-block float-sm-right">1,024 stars today</span>
      </article>`;
    const [item] = parseGithubTrending(html);
    expect(item).toMatchObject({
      title: "owner/cool-agent",
      stars: 12345,
      starsToday: 1024,
      language: "TypeScript",
    });
    expect(classifyFeedItem(item!)).toContain("ai");
  });
});

describe("misc", () => {
  it("Claude 项目目录编码", () => {
    expect(encodeClaudeProjectPath("D:\\agent\\DevFlow-AI")).toBe("D--agent-DevFlow-AI");
  });

  it("后端部署预设", () => {
    const steps = buildBackendDeploySteps({
      remoteDir: "/www/im",
      projectType: "java",
      projectName: "im",
      buildCommand: "mvn package",
      healthUrl: "https://im.example.com/health",
    });
    expect(steps.map((s) => s.type)).toEqual([
      "login",
      "terminal",
      "terminal",
      "restartProject",
      "httpCheck",
      "screenshot",
    ]);
  });
});
