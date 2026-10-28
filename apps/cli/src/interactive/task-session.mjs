import { render } from "ink";
import { createElement } from "react";
import { apiRequest } from "../client.mjs";
import {
  AGENTS,
  createOrContinueTask,
  DEFAULT_RESUME_MESSAGE,
  TASK_SUCCESS_STATUSES,
} from "../commands.mjs";
import { runningState } from "../lifecycle.mjs";
import TaskView from "./TaskView.jsx";
import { resolveAccessibility } from "./theme.mjs";

function buildTheme(values) {
  return resolveAccessibility({
    tty: Boolean(process.stdout.isTTY),
    env: process.env,
    settings: values,
  });
}

/** 渲染 TaskView 直到退出，退出后重新查询任务终态决定退出码（与一次性路径同一套成功状态集合）。 */
async function renderTaskView(state, task, values, extra = {}) {
  const theme = buildTheme(values);
  const { waitUntilExit } = render(
    createElement(TaskView, { state, task, theme, afterSeq: 0, ...extra }),
  );
  await waitUntilExit();
  const finalTask = await (await apiRequest(state, `/tasks/${encodeURIComponent(task.id)}`)).json();
  if (!TASK_SUCCESS_STATUSES.has(finalTask.status)) process.exitCode = 1;
}

export async function runInteractiveTask(home, workerPath, goal, values) {
  const state = await runningState(home, workerPath);
  if (values.agent && !AGENTS.includes(values.agent))
    throw new Error(`--agent 可选值：${AGENTS.join(", ")}`);
  const trimmed = (goal ?? "").trim();
  if (!trimmed) throw new Error('run 需要任务目标，例如 agentdesk run "修复登录页报错"');
  const taskId = await createOrContinueTask(state, trimmed, values);
  const task = await (await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  await renderTaskView(state, task, values);
}

export async function runInteractiveInspect(home, workerPath, taskId, values) {
  const state = await runningState(home, workerPath);
  const task = await (await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  const records = await (
    await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}/events?after=0&limit=200`)
  ).json();
  const afterSeq = records.at(-1)?.seq ?? 0;
  await renderTaskView(state, task, values, { snapshot: { task, records }, afterSeq });
}

export async function runInteractiveResume(home, workerPath, taskId, values) {
  const state = await runningState(home, workerPath);
  await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}/runs`, {
    method: "POST",
    body: JSON.stringify({ trigger: "resume", message: values.message ?? DEFAULT_RESUME_MESSAGE }),
  });
  const task = await (await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  await renderTaskView(state, task, values);
}
