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

export async function initialize(home, workerPath, values, { version = "" } = {}) {
  const ui = createUi();
  await ui.welcome("连接模型，开启你的 Agent 之旅", version);
  const state = await runningState(home, workerPath);
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

export async function chat(home, workerPath, message, values) {
  const state = await runningState(home, workerPath);
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

/** 一次性路径与交互式路径（task-session.mjs）判定 Task 是否"算成功退出"的同一套终态集合。 */
export const TASK_SUCCESS_STATUSES = new Set(["completed", "awaiting_review"]);

/**
 * resume 未传 --message 时的默认值：POST /tasks/:id/runs 的 message 字段要求非空
 * （见 apps/sidecar/src/http/routes/tasks.ts 的 CreateRunBody），而 resume 的语义本来就是
 * "不用重新说明、接着上次失败的地方继续"——真正的上次失败原因/工具调用摘要已经由后端
 * task-executor.ts 的 resumeContext 拼进了这次执行的 context，这里只是满足 schema 的非空要求。
 */
export const DEFAULT_RESUME_MESSAGE = "继续执行";

const RUN_TRIGGER_LABEL = {
  create: "新建",
  followup: "追加指令",
  resume: "重跑",
  continue: "继续",
  delegate: "委派",
};

/** --conversation 传了就对已有任务发追加指令；没传就新建任务。返回目标 taskId。 */
export async function createOrContinueTask(state, goal, values) {
  if (values.conversation) {
    await apiRequest(state, `/tasks/${encodeURIComponent(values.conversation)}/runs`, {
      method: "POST",
      body: JSON.stringify({ trigger: "followup", message: goal }),
    });
    return values.conversation;
  }
  const created = await (
    await apiRequest(state, "/tasks", {
      method: "POST",
      body: JSON.stringify({
        goal,
        agent: values.agent,
        requiresPlanApproval: values.plan === true,
      }),
    })
  ).json();
  return created.id;
}

/** 非 JSON 一次性路径下，把一条 RunEventRecord 简要打印到对应流（文本走 stdout，其余走 stderr）。 */
function printTaskEventText(record) {
  const { event, parentRunId } = record;
  const prefix = parentRunId ? "[子运行] " : "";
  switch (event.type) {
    case "run_started":
      process.stderr.write(
        `\n${prefix}▶ 运行开始（agent=${event.agent}, ${RUN_TRIGGER_LABEL[event.trigger] ?? event.trigger}）\n`,
      );
      break;
    case "run_ended":
      process.stderr.write(
        `\n${prefix}■ 运行结束：${event.status}${event.error ? `（${event.error}）` : ""}\n`,
      );
      break;
    case "task_status":
      process.stderr.write(`\n· 任务状态：${event.status}\n`);
      break;
    case "plan_updated":
      process.stderr.write(`\n· 方案已更新（版本 ${event.version}）\n`);
      break;
    case "route":
      process.stderr.write(`\n${prefix}↳ 委派给 ${event.agent}：${event.reason}\n`);
      break;
    case "tool_call":
      process.stderr.write(`\n${prefix}[工具] ${event.name}\n`);
      break;
    case "approval_required":
      process.stderr.write(`\n${prefix}[审批] ${event.title}\n${event.detail}\n`);
      break;
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "error":
      process.stderr.write(`\n${prefix}✗ ${event.message}\n`);
      break;
    default:
      break;
  }
}

/** 一次性路径共用的事件消费：打印 + 审批 y/n（非交互自动拒绝，与 chat() 保持一致）。 */
async function consumeTaskEvents(state, response, { json, interactivePrompt }) {
  await consumeSse(response.body, async (record) => {
    const { event } = record;
    if (json) process.stdout.write(`${JSON.stringify({ seq: record.seq, event })}\n`);
    else printTaskEventText(record);
    if (event.type === "approval_required") {
      let approved = false;
      if (interactivePrompt) {
        const answer = await question(`\n[审批] ${event.title}\n${event.detail}\n是否允许？[y/N] `);
        approved = /^(y|yes|是)$/i.test(answer);
      } else process.stderr.write(`\n非交互模式已拒绝审批 ${event.approvalId}，未自动授权。\n`);
      await apiRequest(state, `/approvals/${encodeURIComponent(event.approvalId)}`, {
        method: "POST",
        body: JSON.stringify({ approved }),
      });
    }
  });
}

/**
 * 一次性路径跟流直到结束，再查一次任务终态决定退出码。Ctrl+C 只断开本地连接（AbortController），
 * 刻意不调用 POST /tasks/:id/cancel——关闭页面/断开连接不应意外取消后端正在执行的任务，这是
 * 开发任务.md 开篇就定下的全局原则；取消任务只能通过显式的 `agentdesk cancel <taskId>` 完成。
 */
export async function followTaskOneShot(state, taskId, values, { afterSeq = 0 } = {}) {
  // run_started 事件只带 runId，不带 taskId（见 packages/shared/src/contracts/task.ts），
  // 新建任务时这是用户/脚本唯一能拿到 taskId 的地方——必须在事件流之外单独报一次。
  if (values.json) process.stdout.write(`${JSON.stringify({ taskId })}\n`);
  else process.stderr.write(`任务：${taskId}\n`);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  try {
    const response = await apiRequest(
      state,
      `/tasks/${encodeURIComponent(taskId)}/stream?after=${afterSeq}`,
      { signal: controller.signal },
    );
    if (!response.body) throw new Error("服务未返回事件流。");
    const interactivePrompt = !values.json && process.stdin.isTTY && process.stderr.isTTY;
    await consumeTaskEvents(state, response, { json: values.json, interactivePrompt });
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
  const task = await (await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  if (values.json)
    process.stdout.write(`${JSON.stringify({ taskId: task.id, status: task.status })}\n`);
  else {
    process.stdout.write(`\n任务 ${task.id} 当前状态：${task.status}\n`);
    if (task.pendingApprovalId)
      process.stdout.write(
        `待处理审批：${task.pendingApprovalId}（使用 agentdesk approvals/approve/reject 处理）\n`,
      );
  }
  if (!TASK_SUCCESS_STATUSES.has(task.status)) process.exitCode = 1;
}

export async function runTask(home, workerPath, goal, values) {
  const state = await runningState(home, workerPath);
  if (values.agent && !AGENTS.includes(values.agent))
    throw new Error(`--agent 可选值：${AGENTS.join(", ")}`);
  const trimmed = (goal ?? "").trim();
  if (!trimmed) throw new Error('run 需要任务目标，例如 agentdesk run "修复登录页报错"');
  const taskId = await createOrContinueTask(state, trimmed, values);
  await followTaskOneShot(state, taskId, values, { afterSeq: 0 });
}

function truncateId(id, length = 10) {
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

export async function listTasks(home, workerPath, values) {
  const state = await runningState(home, workerPath);
  const query = values.status ? `?status=${encodeURIComponent(values.status)}` : "";
  const tasks = await (await apiRequest(state, `/tasks${query}`)).json();
  if (values.json) {
    console.info(JSON.stringify(tasks, null, 2));
    return;
  }
  const ui = createUi({ stream: process.stdout });
  ui.header("任务列表");
  if (!tasks.length) {
    ui.note("暂无任务。");
    ui.outro(`创建任务：${nextCommand('run "..."', home)}`);
    return;
  }
  for (const task of tasks) {
    ui.card(`${truncateId(task.id)}  [${task.status}]  ${task.title}`, [
      ["创建", task.createdAt],
      ["更新", task.updatedAt],
    ]);
  }
  ui.outro(`共 ${tasks.length} 个任务`);
}

/** 时间线里跳过逐字的 text_delta，只保留结构性事件，避免刷屏。 */
function formatTimelineLine(record) {
  const { event, runId, parentRunId } = record;
  const prefix = parentRunId ? `  ↳[${truncateId(runId, 8)}] ` : `[${truncateId(runId, 8)}] `;
  switch (event.type) {
    case "run_started":
      return `${prefix}运行开始 agent=${event.agent} trigger=${RUN_TRIGGER_LABEL[event.trigger] ?? event.trigger}`;
    case "run_ended":
      return `${prefix}运行结束 ${event.status}${event.error ? `（${event.error}）` : ""}`;
    case "task_status":
      return `[任务] 状态变为 ${event.status}`;
    case "plan_updated":
      return `[任务] 方案更新到版本 ${event.version}`;
    case "route":
      return `${prefix}委派给 ${event.agent}：${event.reason}`;
    case "agent_start":
      return `${prefix}Agent ${event.agent} 开始执行`;
    case "agent_end":
      return `${prefix}Agent ${event.agent} 结束`;
    case "tool_call":
      return `${prefix}调用工具 ${event.name}`;
    case "tool_result":
      return `${prefix}工具结果 ${event.isError ? "失败" : "成功"}`;
    case "approval_required":
      return `${prefix}需要审批：${event.title}`;
    case "error":
      return `${prefix}错误：${event.message}`;
    default:
      return null;
  }
}

/**
 * GET /tasks/:id + GET /tasks/:id/events 快照打印。当前后端未暴露任何 artifacts HTTP 路由
 * （TaskService.recordArtifact/listArtifacts 只是服务层方法，apps/sidecar/src/http/routes/tasks.ts
 * 没有对应路由），因此方案概要只能从事件流里的 plan_updated（若有）读出版本号，无法取到产物正文；
 * 这是后端实际接口缺口，不是 CLI 遗漏，按仓库约定不在本阶段新增后端路由来凑齐它。
 */
export async function inspectTask(home, workerPath, taskId, values) {
  const state = await runningState(home, workerPath);
  const task = await (await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  const records = await (
    await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}/events?after=0&limit=200`)
  ).json();
  const latestPlan = records.filter((r) => r.event.type === "plan_updated").at(-1)?.event;
  if (values.json) {
    // --follow 时后面还会跟着 NDJSON 的 {seq,event} 行，这一行快照必须保持单行 JSON，
    // 否则按行解析的脚本会把缩进后的多行快照和 NDJSON 事件行混在一起。
    console.info(JSON.stringify({ task, events: records, latestPlan: latestPlan ?? null }));
  } else {
    const ui = createUi({ stream: process.stdout });
    ui.header(`任务：${task.title}`);
    ui.card("概况", [
      ["ID", task.id],
      ["状态", task.status],
      ["目标", task.goal],
      ["创建", task.createdAt],
      ["更新", task.updatedAt],
    ]);
    if (task.pendingApprovalId)
      ui.note(
        `待处理审批 ${task.pendingApprovalId}：使用 agentdesk approvals/approve/reject 处理。`,
      );
    if (latestPlan)
      ui.note(
        `最新方案：版本 ${latestPlan.version}（产物 ID ${latestPlan.artifactId}；当前 API 未提供产物内容查询）。`,
      );
    const lines = records.map(formatTimelineLine).filter(Boolean);
    const tail = lines.slice(-50);
    ui.note(
      `最近事件（共 ${lines.length} 条${lines.length > tail.length ? `，仅显示最后 ${tail.length} 条` : ""}）：`,
    );
    for (const line of tail) ui.note(`  ${line}`);
    if (!values.follow) ui.outro(nextCommand(`inspect ${task.id} --follow`, home));
  }
  if (!values.follow) return;
  const afterSeq = records.at(-1)?.seq ?? 0;
  await followTaskOneShot(state, taskId, values, { afterSeq });
}

export async function cancelTaskCommand(home, workerPath, taskId, values) {
  const state = await runningState(home, workerPath);
  const task = await (
    await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" })
  ).json();
  if (values.json) {
    console.info(JSON.stringify(task, null, 2));
    return;
  }
  const terminal = new Set(["completed", "failed", "cancelled", "closed"]);
  if (task.status === "cancelled") console.info(`任务 ${task.id} 已取消。`);
  else if (terminal.has(task.status))
    console.info(`任务 ${task.id} 已处于终态（${task.status}），无需取消。`);
  else
    console.info(
      `任务 ${task.id} 当前状态：${task.status}（取消请求已提交，执行中的运行会尽快中止）。`,
    );
}

export async function resumeTask(home, workerPath, taskId, values) {
  const state = await runningState(home, workerPath);
  await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}/runs`, {
    method: "POST",
    body: JSON.stringify({ trigger: "resume", message: values.message ?? DEFAULT_RESUME_MESSAGE }),
  });
  await followTaskOneShot(state, taskId, values, { afterSeq: 0 });
}
