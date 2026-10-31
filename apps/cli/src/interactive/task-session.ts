import { render } from "ink";
import { createElement } from "react";
import type { RunEventRecord, Task } from "@agentdesk/shared";
import type { CliValues } from "../args.js";
import { apiRequest, type ApiState } from "../client.js";
import {
  AGENTS,
  createOrContinueTask,
  DEFAULT_RESUME_MESSAGE,
  TASK_SUCCESS_STATUSES,
} from "../commands.js";
import { runningState } from "../lifecycle.js";
import TaskView, { type TaskViewProps } from "./TaskView.js";
import { resolveAccessibility } from "./theme.js";

function buildTheme(values: CliValues) {
  return resolveAccessibility({
    tty: Boolean(process.stdout.isTTY),
    env: process.env,
    settings: values,
  });
}

/** 渲染 TaskView 直到退出，退出后重新查询任务终态决定退出码（与一次性路径同一套成功状态集合）。 */
async function renderTaskView(
  state: ApiState,
  task: Task,
  values: CliValues,
  extra: Pick<TaskViewProps, "snapshot" | "afterSeq"> = {},
) {
  const theme = buildTheme(values);
  const { waitUntilExit } = render(
    createElement(TaskView, { state, task, theme, afterSeq: 0, ...extra }),
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
  const finalTask = await (
    await apiRequest<Task>(state, `/tasks/${encodeURIComponent(task.id)}`)
  ).json();
  if (!TASK_SUCCESS_STATUSES.has(finalTask.status)) process.exitCode = 1;
}

export async function runInteractiveTask(
  home: string,
  workerPath: string,
  goal: string | undefined,
  values: CliValues,
) {
  const state = await runningState(home, workerPath);
  if (values.agent && !AGENTS.includes(values.agent))
    throw new Error(`--agent 可选值：${AGENTS.join(", ")}`);
  const trimmed = (goal ?? "").trim();
  if (!trimmed) throw new Error('run 需要任务目标，例如 agentdesk run "修复登录页报错"');
  const taskId = await createOrContinueTask(state, trimmed, values);
  const task = await (await apiRequest<Task>(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  await renderTaskView(state, task, values);
}

export async function runInteractiveInspect(
  home: string,
  workerPath: string,
  taskId: string,
  values: CliValues,
) {
  const state = await runningState(home, workerPath);
  const task = await (await apiRequest<Task>(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  const records = await (
    await apiRequest<RunEventRecord[]>(
      state,
      `/tasks/${encodeURIComponent(taskId)}/events?after=0&limit=200`,
    )
  ).json();
  const afterSeq = records.at(-1)?.seq ?? 0;
  await renderTaskView(state, task, values, { snapshot: { task, records }, afterSeq });
}

export async function runInteractiveResume(
  home: string,
  workerPath: string,
  taskId: string,
  values: CliValues,
) {
  const state = await runningState(home, workerPath);
  await apiRequest(state, `/tasks/${encodeURIComponent(taskId)}/runs`, {
    method: "POST",
    body: JSON.stringify({ trigger: "resume", message: values.message ?? DEFAULT_RESUME_MESSAGE }),
  });
  const task = await (await apiRequest<Task>(state, `/tasks/${encodeURIComponent(taskId)}`)).json();
  await renderTaskView(state, task, values);
}
