import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { apiRequest, consumeSse } from "./client.mjs";
import { runningState, serviceStatus } from "./lifecycle.mjs";
import { question, select } from "./terminal.mjs";
import { createUi, nextCommand } from "./ui.mjs";

export const AGENTS = ["orchestrator", "project", "deploy", "research", "code"];

export async function initialize(home, values, { version = "" } = {}) {
  const ui = createUi();
  await ui.welcome("连接模型，开启你的 Agent 之旅", version);
  const state = await runningState(home);
  const providers = await (await apiRequest(state, "/providers")).json();
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  if (providers.some((p) => p.enabled) && !values["base-url"] && !values.model) {
    const action = interactive
      ? await select(`${ui.icon("⚙️")}已有模型配置，你想做什么？`, [
          { label: "保留当前配置", value: "keep", hint: "直接开始对话" },
          { label: "重新配置模型", value: "configure", hint: "修改协议、地址或密钥" },
        ])
      : "keep";
    if (action === "keep") {
      ui.note(nextCommand('chat "你好"', home));
      ui.outro("配置已保留");
      return;
    }
  }
  ui.note(`数据目录  ${home}`);
  const api =
    values.api ??
    (interactive && !(values["base-url"] && values.model && values["api-key-env"])
      ? await select(`${ui.icon("🔌")}选择模型协议`, [
          {
            label: "OpenAI Compatible",
            value: "openai-completions",
            hint: "OpenAI、DeepSeek、Ollama 等",
          },
          { label: "Anthropic Messages", value: "anthropic-messages", hint: "Claude API" },
        ])
      : "openai-completions");
  if (!["openai-completions", "anthropic-messages"].includes(api))
    throw new Error("--api 协议无效。");
  await ui.advance(1, 4, "协议已选择，接下来填写地址");
  const defaultUrl =
    api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  const validateUrl = (value) =>
    /^https?:\/\//.test(value ?? "") && URL.canParse(value)
      ? undefined
      : "请输入完整的 HTTP/HTTPS 地址，例如 https://api.example.com/v1";
  const baseUrl =
    values["base-url"] ??
    (await question(`${ui.icon("🔗")}模型 API 地址`, {
      defaultValue: defaultUrl,
      validate: validateUrl,
    }));
  if (validateUrl(baseUrl)) throw new Error("模型 API 地址必须为有效 HTTP/HTTPS URL。");
  await ui.advance(2, 4, "地址已填写，选择你的模型");
  const model =
    values.model ??
    (await question(`${ui.icon("🧠")}模型名称`, {
      placeholder:
        api === "anthropic-messages" ? "例如 claude-sonnet-4-6" : "例如 gpt-5.4、deepseek-chat",
      validate: (value) => (value?.trim() ? undefined : "请输入模型名称。"),
    }));
  if (!model.trim()) throw new Error("模型名称不能为空。");
  await ui.advance(3, 4, "模型已填写，最后保存凭据");
  const keyVariable = values["api-key-env"];
  if (keyVariable && !process.env[keyVariable]?.trim())
    throw new Error(`环境变量 ${keyVariable} 未配置或为空。`);
  const apiKey = keyVariable
    ? process.env[keyVariable].trim()
    : await question(`${ui.icon("🔐")}API Key`, {
        secret: true,
        placeholder: "仅在本机加密保存",
        validate: (value) =>
          value?.trim() ? undefined : "请输入 API Key；本地免认证服务可填写占位值。",
      });
  if (!apiKey.trim()) throw new Error("API Key 不能为空；无需认证的本地服务可填写其允许的占位值。");
  await ui.advance(4, 4, "信息已填写，准备加密保存");
  const existing = providers.find((p) => p.name === "AgentDesk CLI" && p.api === api);
  await ui.task("正在保存模型配置…", async () => {
    const provider = await (
      await apiRequest(state, existing ? `/providers/${existing.id}` : "/providers", {
        method: existing ? "PUT" : "POST",
        body: JSON.stringify({
          name: "AgentDesk CLI",
          api,
          baseUrl,
          models: [model],
          defaultModel: model,
          apiKey,
          source: "manual",
          enabled: true,
        }),
      })
    ).json();
    await apiRequest(state, "/agent-bindings", {
      method: "PUT",
      body: JSON.stringify(
        AGENTS.map((agent) => ({ agent, providerId: provider.id, model, fallbackProviderIds: [] })),
      ),
    });
  });
  ui.card(`${ui.icon("✅")}模型配置已保存`, [
    ["模型", model],
    ["协议", api],
    ["凭据", "已加密保存；尚未调用模型验证连接"],
  ]);
  ui.note(`开始对话：${nextCommand('chat "你好"', home)}`);
  ui.outro("配置完成，开始创造吧。");
}

export async function chat(home, message, values) {
  const state = await runningState(home);
  if (values.agent && !AGENTS.includes(values.agent))
    throw new Error(`--agent 可选值：${AGENTS.join(", ")}`);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  let done = false;
  let failure;
  try {
    const response = await apiRequest(state, "/chat", {
      method: "POST",
      body: JSON.stringify({ message, agent: values.agent, conversationId: values.conversation }),
      signal: controller.signal,
    });
    if (!response.body) throw new Error("服务未返回事件流。");
    await consumeSse(response.body, async (event) => {
      if (values.json) process.stdout.write(`${JSON.stringify(event)}\n`);
      if (event.type === "conversation" && !values.json)
        process.stderr.write(`会话：${event.conversationId}\n`);
      if (event.type === "text_delta" && !values.json) process.stdout.write(event.delta);
      if (event.type === "tool_call" && !values.json)
        process.stderr.write(`\n[工具] ${event.name}\n`);
      if (event.type === "approval_required") {
        let approved = false;
        if (!values.json && process.stdin.isTTY && process.stderr.isTTY) {
          const answer = await question(
            `\n[审批] ${event.title}\n${event.detail}\n是否允许？[y/N] `,
          );
          approved = /^(y|yes|是)$/i.test(answer);
        } else process.stderr.write(`\n非交互模式已拒绝审批 ${event.approvalId}，未自动授权。\n`);
        await apiRequest(state, `/approvals/${encodeURIComponent(event.approvalId)}`, {
          method: "POST",
          body: JSON.stringify({ approved }),
        });
      }
      if (event.type === "error") failure = event.message;
      if (event.type === "done") done = true;
    });
    if (failure) throw new Error(failure);
    if (!done) throw new Error("连接已结束，但未收到执行完成事件。请检查日志后重试。");
    if (!values.json) process.stdout.write("\n");
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

export async function doctor(home, workerPath, json) {
  const node = process.versions.node.split(".").map(Number);
  const checks = [
    {
      name: "Node.js",
      ok: node[0] > 22 || (node[0] === 22 && node[1] >= 12),
      detail: process.version,
    },
  ];
  try {
    checks.push({
      name: "Git",
      ok: true,
      detail: execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).trim(),
    });
  } catch {
    checks.push({ name: "Git", ok: false, detail: "请安装 Git 并加入 PATH。" });
  }
  checks.push({
    name: "运行文件",
    ok: existsSync(workerPath),
    detail: existsSync(workerPath) ? "已生成" : "请执行 pnpm build:cli。",
  });
  try {
    const requireRuntime = createRequire(workerPath);
    const Database = requireRuntime("better-sqlite3");
    const database = new Database(":memory:");
    database.close();
    checks.push({ name: "SQLite 原生模块", ok: true, detail: "与当前 Node 运行时匹配" });
  } catch (error) {
    checks.push({
      name: "SQLite 原生模块",
      ok: false,
      detail: `请在当前 Node 版本下重新安装或重建依赖：${error.message}`,
    });
  }
  const service = await serviceStatus(home);
  checks.push({ name: "服务", ok: service.status === "running", detail: service.status });
  if (service.status === "running") {
    const health = await (await apiRequest(service.state, "/health")).json();
    const providers = await (await apiRequest(service.state, "/providers")).json();
    checks.push({ name: "数据库与原生依赖", ok: health.ok === true, detail: health.secretBackend });
    const enabled = providers.filter((p) => p.enabled);
    checks.push({
      name: "模型配置",
      ok: enabled.length > 0,
      detail: `${enabled.length} 个已启用（未发起模型网络请求）`,
    });
  }
  if (json) console.info(JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2));
  else {
    const ui = createUi({ stream: process.stdout });
    ui.header("环境诊断");
    for (const check of checks) {
      if (check.ok) ui.success(`${check.name}：${check.detail}`);
      else ui.error(`${check.name}：${check.detail}`);
    }
    ui.note(`数据目录：${home}`);
    if (service.status !== "running") ui.note(`启动服务：${nextCommand("start", home)}`);
    else if (!checks.every((c) => c.ok)) ui.note(`配置模型：${nextCommand("init", home)}`);
    ui.outro(checks.every((c) => c.ok) ? "检查通过" : "请根据上方提示完成配置");
  }
  return checks.every((c) => c.ok);
}

export async function logs(home, { lines = "80", follow = false } = {}) {
  const file = join(home, "daemon.log");
  if (!existsSync(file)) {
    console.info("暂无后台日志。前台模式的日志直接输出到启动终端。");
    return;
  }
  let position = 0;
  const initial = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(Math.min(initial, 256 * 1024));
    const count = readSync(fd, bytes, 0, bytes.length, Math.max(0, initial - bytes.length));
    const text = bytes
      .subarray(0, count)
      .toString("utf8")
      .trimEnd()
      .split(/\r?\n/)
      .slice(-Number(lines))
      .join("\n");
    if (text) process.stdout.write(`${text}\n`);
    position = initial;
  } finally {
    closeSync(fd);
  }
  if (!follow) return;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!controller.signal.aborted) {
      await delay(400, undefined, { signal: controller.signal });
      const size = statSync(file).size;
      if (size < position) position = 0;
      if (size === position) continue;
      const fd = openSync(file, "r");
      try {
        const bytes = Buffer.alloc(Math.min(size - position, 256 * 1024));
        const count = readSync(fd, bytes, 0, bytes.length, position);
        position += count;
        process.stdout.write(bytes.subarray(0, count));
      } finally {
        closeSync(fd);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
