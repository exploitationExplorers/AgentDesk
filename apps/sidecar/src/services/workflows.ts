import { completeText, type Orchestrator, type ToolRegistry } from "@agentdesk/agent-core";
import { gitLog, gitStatus } from "@agentdesk/integrations";
import { AgentName, AppError, ErrorCode } from "@agentdesk/shared";
import {
  WORKFLOW_TEMPLATES,
  WorkflowInput,
  executeWorkflow,
  httpHandler,
  renderString,
  validateWorkflow,
  type NodeHandlers,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunEvent,
} from "@agentdesk/workflow";
import { runCheckedShell, shellRisk } from "../agents/shell-policy";
import type { Db } from "../db/client";
import { Collection } from "../db/collection";
import { GLOBAL_CHANNEL, type EventHub, type GlobalEvent } from "../events";
import { errorMessage, localDate, newId, nowIso, toJsonSafe } from "../util";
import type { ApprovalService } from "./approvals";
import type { DeployService } from "./deploy";
import type { ProjectService } from "./projects";
import type { ProviderService } from "./providers";

export const workflowChannel = (runId: string) => `workflow:${runId}`;

type ScheduleDoc = { id: string; lastRunDate: string };

export interface WorkflowServiceDeps {
  db: Db;
  hub: EventHub;
  approvals: ApprovalService;
  providers: ProviderService;
  orchestrator: Orchestrator;
  registry: ToolRegistry;
  projects: ProjectService;
  deploy: DeployService;
}

export class WorkflowService {
  private readonly workflows: Collection<Workflow>;
  private readonly runs: Collection<WorkflowRun & { id: string }>;
  private readonly schedules: Collection<ScheduleDoc>;
  private readonly live = new Map<string, WorkflowRun>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<WorkflowRun>>();

  constructor(private readonly deps: WorkflowServiceDeps) {
    this.workflows = new Collection<Workflow>(deps.db, "workflows");
    this.runs = new Collection<WorkflowRun & { id: string }>(deps.db, "workflowRuns");
    this.schedules = new Collection<ScheduleDoc>(deps.db, "workflowSchedules");
    for (const run of this.runs.list()) {
      if (run.status === "running")
        this.runs.put({
          ...run,
          status: "failed",
          error: "sidecar 重启，任务中断",
          endedAt: nowIso(),
        });
    }
  }

  list(): Workflow[] {
    return this.workflows.list();
  }

  get(id: string): Workflow {
    const w = this.workflows.get(id);
    if (!w) throw new AppError(ErrorCode.NotFound, "工作流不存在");
    return w;
  }

  save(input: unknown, id?: string): Workflow {
    const data = WorkflowInput.parse(input);
    try {
      validateWorkflow(data);
    } catch (error) {
      throw new AppError(ErrorCode.BadRequest, errorMessage(error));
    }
    const existing = id ? this.get(id) : undefined;
    return this.workflows.put({
      id: id ?? newId(),
      ...data,
      version: (existing?.version ?? 0) + 1,
      updatedAt: nowIso(),
    });
  }

  delete(id: string): void {
    this.workflows.delete(id);
  }

  templates() {
    return WORKFLOW_TEMPLATES.map(({ key, name, description }) => ({ key, name, description }));
  }

  createFromTemplate(key: string): Workflow {
    const template = WORKFLOW_TEMPLATES.find((t) => t.key === key);
    if (!template) throw new AppError(ErrorCode.NotFound, "模板不存在");
    return this.save(template.build());
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    const all = this.runs.list();
    return (workflowId ? all.filter((r) => r.workflowId === workflowId) : all)
      .slice(0, 30)
      .map((r) => this.live.get(r.id) ?? r);
  }

  getRun(id: string): WorkflowRun {
    const run = this.live.get(id) ?? this.runs.get(id);
    if (!run) throw new AppError(ErrorCode.NotFound, "运行记录不存在");
    return run;
  }

  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }

  wait(id: string): Promise<WorkflowRun> {
    return this.completions.get(id) ?? Promise.resolve(this.getRun(id));
  }

  run(workflowId: string, inputs: Record<string, string>): WorkflowRun {
    const workflow = this.get(workflowId);
    // 同工作流只保留一个进行中的实例，避免未点完的审批在全局页面堆叠
    for (const [id, live] of this.live) {
      if (live.workflowId === workflowId && live.status === "running") this.cancel(id);
    }
    const resolvedInputs = Object.fromEntries(
      workflow.inputs.map((i) => [i.name, inputs[i.name] ?? i.default]),
    );
    const run: WorkflowRun = {
      id: newId(),
      workflowId,
      workflowName: workflow.name,
      status: "running",
      inputs: { ...inputs, ...resolvedInputs },
      nodeStates: Object.fromEntries(
        workflow.nodes.map((n) => [n.id, { status: "pending" as const }]),
      ),
      output: null,
      error: null,
      startedAt: nowIso(),
      endedAt: null,
    };
    this.live.set(run.id, run);
    this.runs.put(run);
    const channel = workflowChannel(run.id);
    this.deps.hub.retain(channel);

    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const ctx = { approved: false, workflowName: workflow.name, runId: run.id };

    const onEvent = (event: WorkflowRunEvent) => {
      const current = this.live.get(run.id);
      if (!current) return;
      const states = current.nodeStates;
      switch (event.type) {
        case "node_start":
          states[event.nodeId] = { status: "running" };
          break;
        case "node_end":
          states[event.nodeId] = { status: "succeeded", output: event.output };
          break;
        case "node_error":
          states[event.nodeId] = { status: "failed", error: event.error };
          break;
        case "node_skip":
          states[event.nodeId] = { status: "skipped" };
          break;
      }
      this.deps.hub.publish(channel, event);
    };

    const completion = executeWorkflow(workflow, {
      runId: run.id,
      inputs: run.inputs,
      handlers: this.handlers(ctx),
      onEvent,
      signal: controller.signal,
    })
      .catch((error) => ({
        status: "failed" as const,
        output: null,
        error: errorMessage(error),
        outputs: {},
      }))
      .then((result) => {
        const final: WorkflowRun = toJsonSafe({
          ...this.live.get(run.id)!,
          status: result.status,
          output: result.output,
          error: result.error ?? null,
          endedAt: nowIso(),
        });
        this.runs.put(final);
        this.live.delete(run.id);
        this.controllers.delete(run.id);
        this.deps.hub.publish(GLOBAL_CHANNEL, {
          type: "workflow_updated",
          runId: run.id,
          status: final.status,
        } satisfies GlobalEvent);
        return final;
      });
    this.completions.set(run.id, completion);
    void completion.finally(() => this.completions.delete(run.id));
    return run;
  }

  /** 宿主侧节点执行器：把工作流节点接到 Agent、工具、Git、部署和审批能力上 */
  private handlers(ctx: { approved: boolean; workflowName: string; runId: string }): NodeHandlers {
    const { approvals, providers, orchestrator, registry, projects, deploy, hub } = this.deps;
    const wfPayload = { runId: ctx.runId, workflowName: ctx.workflowName };
    const approve = async (title: string, detail: string, signal: AbortSignal) => {
      const ok = await approvals.request(
        {
          kind: "workflow",
          title,
          detail: `来自工作流「${ctx.workflowName}」\n${detail}`,
          risk: "confirm",
          payload: wfPayload,
        },
        signal,
      );
      if (!ok) throw new Error("审批被拒绝");
      ctx.approved = true;
    };

    return {
      http: httpHandler,
      llm: async ({ config, signal }) =>
        completeText({
          models: await providers.resolve("orchestrator"),
          systemPrompt: String(config.system ?? "你是一个有帮助的助手。"),
          prompt: String(config.prompt ?? ""),
          signal,
        }),
      agent: async ({ config, signal, log }) => {
        const agent = AgentName.catch("orchestrator").parse(config.agent);
        const task = String(config.task ?? "");
        const emit = (e: { type: string; name?: string; delta?: string }) => {
          if (e.type === "tool_call" && e.name) log(`调用工具 ${e.name}`);
          // claude.run 等工具的流式输出 → 工作流 node_log
          if (e.type === "text_delta" && e.delta?.trim()) log(e.delta.trimEnd());
        };
        const requestApproval = (r: {
          title: string;
          detail: string;
          risk: "safe" | "confirm" | "dangerous";
          payload: unknown;
        }) =>
          approvals.request(
            {
              kind: "workflow",
              ...r,
              detail: `来自工作流「${ctx.workflowName}」\n${r.detail}`,
              payload: { ...wfPayload, ...(r.payload as object) },
            },
            signal,
          );
        const result =
          agent === "orchestrator"
            ? await orchestrator.run({
                history: [],
                userMessage: task,
                emit,
                requestApproval,
                signal,
              })
            : await orchestrator.runSpecialist(
                agent,
                [{ role: "user", content: task, timestamp: Date.now() }],
                task,
                {
                  emit,
                  requestApproval,
                  signal,
                },
              );
        const text = (result.text ?? "").trim();
        // 工作流「成功」= 节点未抛错；空回复常被误当成修完合 UAT，直接判失败
        if (!text) {
          throw new Error(
            "Agent 未产出任何结论（可能只做了浏览/检索就结束）。仓库未必有改动，请查看日志后重试。",
          );
        }
        return text;
      },
      tool: async ({ config, signal, log }) => {
        const name = String(config.tool ?? "");
        const tool = registry.get(name);
        if (!tool) throw new Error(`工具不存在：${name}`);
        const args =
          typeof config.args === "string" && config.args.trim()
            ? JSON.parse(config.args)
            : (config.args ?? {});
        const risk = tool.riskFor?.(args) ?? tool.risk;
        if (risk !== "safe")
          await approve(`工作流调用 ${name}`, JSON.stringify(args, null, 2), signal);
        log(`执行 ${name}`);
        return tool.execute(args, {
          agent: "orchestrator",
          signal,
          emit: () => {},
          requestApproval: (r) => approvals.request({ kind: "workflow", ...r }, signal),
        });
      },
      shell: async ({ config, signal, log }) => {
        const command = String(config.command ?? "");
        if (shellRisk(command) !== "safe")
          await approve(`执行命令：${command}`, `工作目录：${config.cwd ?? "(默认)"}`, signal);
        const result = await runCheckedShell(command, {
          cwd: config.cwd ? String(config.cwd) : undefined,
          signal,
          onOutput: (chunk) => log(chunk.trimEnd()),
        });
        if (result.code !== 0)
          throw new Error(`退出码 ${result.code}：${result.stderr.slice(-500)}`);
        return result.stdout.trim();
      },
      git: async ({ config }) => {
        const project = projects.find(String(config.projectId ?? ""));
        switch (config.action) {
          case "pull":
            return projects.pull(project.id);
          case "log":
            return gitLog(project.path, 10);
          default:
            return gitStatus(project.path);
        }
      },
      deploy: async ({ config, signal, log }) => {
        const recipeId = String(config.recipeId ?? "");
        const recipe = deploy.getRecipe(recipeId);
        // 上游已有审批节点时不再重复审批
        if (!ctx.approved)
          await approve(`部署「${recipe.name}」`, `${recipe.steps.length} 个步骤`, signal);
        const run = deploy.start(recipeId, { skipApproval: true });
        log(`部署任务 ${run.id} 已启动`);
        signal.addEventListener("abort", () => deploy.cancel(run.id));
        const final = await deploy.wait(run.id);
        if (final.status !== "succeeded")
          throw new Error(final.error ?? `部署状态：${final.status}`);
        return { runId: final.id, status: final.status };
      },
      approval: async ({ config, signal }) => {
        await approve(String(config.title ?? "工作流审批"), String(config.detail ?? ""), signal);
        return { approved: true };
      },
      notify: async ({ config }) => {
        const title = renderString(config.title, {}) || "AgentDesk";
        const body = renderString(config.body, {}).slice(0, 500);
        hub.publish(GLOBAL_CHANNEL, { type: "notification", title, body } satisfies GlobalEvent);
        return { sent: true };
      },
    };
  }

  /** 调度器每分钟调用：到点的定时工作流每天只触发一次 */
  tickSchedules(now: string, today = localDate()): string[] {
    const started: string[] = [];
    for (const workflow of this.list()) {
      if (workflow.trigger.type !== "schedule" || workflow.trigger.time !== now) continue;
      if (this.schedules.get(workflow.id)?.lastRunDate === today) continue;
      this.schedules.put({ id: workflow.id, lastRunDate: today });
      started.push(this.run(workflow.id, {}).id);
    }
    return started;
  }
}
