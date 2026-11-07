import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fsRead } from "@agentdesk/integrations";
import {
  Orchestrator,
  DurableCheckpointError,
  ToolRegistry,
  type AnyAgentTool,
  type AutoApprove,
  type DurableAgentOptions,
  type MaskStore,
} from "@agentdesk/agent-core";
import {
  AppError,
  ErrorCode,
  type AutomationBinding,
  type Task,
  type Run,
} from "@agentdesk/shared";
import { createAutomationAgentDefinition } from "../../agents/definitions";
import type { ProjectInstructionService } from "../project-instructions";
import type { ProjectService } from "../projects";
import type { ProviderService } from "../providers";
import type { PermissionRuleService } from "../permission-rules";
import type { TaskService } from "../tasks";
import { acquireConversation } from "../conversation-activity";
import { ConversationStore } from "../conversation-store";
import { Collection } from "../../db/collection";
import { stableId, type AutoloopStore } from "./store";
import { nowIso } from "../../util";
import { assertBudget } from "./budgets";
import { waitUntilTool } from "./timers";

export interface AutomationExecutorDeps {
  registry: ToolRegistry;
  providers: ProviderService;
  projects: ProjectService;
  projectInstructions: ProjectInstructionService;
  permissionRules: PermissionRuleService;
  tasks: TaskService;
  store: AutoloopStore;
  maskFactory?: () => MaskStore | undefined;
}

const FILE_TOOLS = new Set(["fs.read", "fs.write", "fs.patch", "fs.glob", "fs.search"]);
/** 首期工具边界限定为本地文件与报告产物；每次工具入口重验绑定和拒绝规则。 */
export async function executeAutomation(
  deps: AutomationExecutorDeps,
  binding: AutomationBinding,
  task: Task,
  run: Run,
  signal: AbortSignal,
  resume?: DurableAgentOptions["resume"],
) {
  const release = acquireConversation(task.conversationId, "running");
  try {
    const root = await realpath(
      (await deps.projectInstructions.validateWorkspace(binding.workspacePolicy.root))!,
    );
    const key = (path: string) =>
      process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    const approvedRoot = deps.store.workspaces.get(binding.id)?.realPath;
    if (!approvedRoot || key(approvedRoot) !== key(root))
      throw new AppError(ErrorCode.Conflict, "绑定的工作区位置已变化，请重新创建自动化");
    const registry = new ToolRegistry();
    registry.register(waitUntilTool);
    const approvals = new Collection<{ id: string; hash: string }>(
      deps.store.db,
      "autoloop_resource_approvals_v1",
    );
    const resourceHash = async (args: unknown) => {
      const input = args as { project: string; path: string };
      try {
        return (await fsRead(deps.projects.find(input.project).path, input.path)).hash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    };
    const validate = async (tool: string, args: unknown) => {
      deps.store.assertEpoch();
      signal.throwIfAborted();
      if (deps.store.stopped.get(task.id)) throw new AppError(ErrorCode.Conflict, "任务已停止");
      if (deps.permissionRules.match(tool, args)?.decision === "deny")
        throw new AppError(ErrorCode.ApprovalRequired, "当前权限规则拒绝该操作");
      const current = await realpath(
        (await deps.projectInstructions.validateWorkspace(binding.workspacePolicy.root))!,
      );
      if (key(current) !== key(root)) throw new AppError(ErrorCode.Conflict, "工作区位置已变化");
      if (FILE_TOOLS.has(tool)) {
        const project =
          typeof args === "object" && args !== null
            ? (args as Record<string, unknown>).project
            : undefined;
        if (
          typeof project !== "string" ||
          key(await realpath(deps.projects.find(project).path)) !== key(root)
        )
          throw new AppError(ErrorCode.BadRequest, "此自动化只能访问绑定的项目");
      }
    };
    for (const tool of deps.registry.list()) {
      if (
        !FILE_TOOLS.has(tool.name) &&
        !tool.name.startsWith("presentations.") &&
        !tool.name.startsWith("documents.") &&
        tool.name !== "tasks.ask_user"
      )
        continue;
      const guarded: AnyAgentTool = {
        ...tool,
        ...(tool.name === "fs.write" || tool.name === "fs.patch"
          ? {
              describeApproval: async (args: unknown) => {
                try {
                  await validate(tool.name, args);
                } catch (cause) {
                  throw new DurableCheckpointError("授权操作的资源或权限校验失败，已停止执行", {
                    cause,
                  });
                }
                const id = stableId(task.id, tool.name, args);
                const hash = await resourceHash(args);
                deps.store.assertEpoch();
                if (!approvals.get(id)) approvals.put({ id, hash });
                return tool.describeApproval!(args);
              },
            }
          : {}),
        execute: async (args, ctx) => {
          await validate(tool.name, args);
          return tool.execute(args, ctx);
        },
      };
      registry.register(guarded);
    }
    const autoApprove: AutoApprove = async (tool, args) => {
      await validate(tool, args);
      const rule = deps.permissionRules.match(tool, args);
      return rule?.decision === "allow"
        ? { approved: true, reason: "已保存的权限规则", source: "rule" }
        : { approved: false };
    };
    const job = deps.store.links.list().find((link) => link.runId === run.id)?.job;
    let trigger = run.trigger === "followup" ? "用户追加要求后续办" : "手动触发";
    if (job?.context.events.some((event) => event.type === "schedule.tick"))
      trigger = "计划到时自动触发";
    if (job?.context.timers.length) trigger = "业务等待到期后续办";
    if (job?.context.answers.length) trigger = "用户回答后续办";
    const agents = [
      createAutomationAgentDefinition({
        binding,
        project: deps.projects.find(binding.projectId ?? binding.workspacePolicy.root),
        trigger,
        now: nowIso(),
      }),
    ];
    const orchestrator = new Orchestrator({ agents, registry, resolver: deps.providers });
    const history = new ConversationStore(deps.store.db);
    const saved = deps.store.checkpoints.get(task.id)?.checkpoint;
    assertBudget(binding, saved);
    const drafts = new Collection<{ id: string; value: unknown }>(
      deps.store.db,
      "autoloop_drafts_v1",
    );
    const draftId = (key: string) => JSON.stringify([task.id, key]);
    const result = await orchestrator.run({
      agent: "orchestrator",
      history: [],
      userMessage: binding.goal,
      allowedTools: registry.list().map((t) => t.name),
      signal,
      autoApprove,
      mask: deps.maskFactory?.(),
      context: await deps.projectInstructions.load(binding.workspacePolicy.root, signal),
      requestApproval: async () => {
        throw new Error("自动化授权必须持久化");
      },
      requestAnswer: async () => {
        throw new Error("自动化问题必须持久化");
      },
      emit: (event) => {
        deps.store.assertEpoch();
        deps.tasks.appendEvent({ taskId: task.id, runId: run.id, event });
      },
      recordArtifact: (input) => {
        deps.store.assertEpoch();
        signal.throwIfAborted();
        const artifact = deps.tasks.recordArtifact({ ...input, taskId: task.id, runId: run.id });
        deps.tasks.appendEvent({
          taskId: task.id,
          runId: run.id,
          event: { type: "artifact_ready", artifactId: artifact.id, title: artifact.title },
        });
        return artifact;
      },
      durableState: {
        get: (key) => drafts.get(draftId(key))?.value,
        set: (key, value) => {
          deps.store.assertEpoch();
          signal.throwIfAborted();
          drafts.put({ id: draftId(key), value });
        },
        delete: (key) => {
          deps.store.assertEpoch();
          signal.throwIfAborted();
          drafts.delete(draftId(key));
        },
      },
      durable: {
        checkpoint: saved,
        resume,
        save: (checkpoint) => {
          deps.store.saveCheckpoint(task.id, checkpoint);
          assertBudget(binding, checkpoint);
        },
        validateApproval: async (request) => {
          const payload = request.payload as { tool?: string; args?: unknown };
          if (!payload.tool) throw new AppError(ErrorCode.BadRequest, "授权缺少操作信息");
          await validate(payload.tool, payload.args);
          if (payload.tool === "fs.write" || payload.tool === "fs.patch") {
            const approved = approvals.get(stableId(task.id, payload.tool, payload.args));
            if (!approved || approved.hash !== (await resourceHash(payload.args)))
              throw new AppError(ErrorCode.Conflict, "待授权文件已变化，请核实内容后重新发起任务");
          }
        },
      },
    });
    deps.store.assertEpoch();
    signal.throwIfAborted();
    const messageId = stableId(
      "automation-message",
      run.id,
      deps.store.checkpoints.get(task.id)?.checkpoint.revision,
    );
    if (!history.listMessages(task.conversationId).some((message) => message.id === messageId))
      history.insertMessage({
        id: messageId,
        conversationId: task.conversationId,
        role: "assistant",
        agent: "orchestrator",
        content: result.status === "suspended" ? result.suspension.request.detail : result.text,
        toolCalls: result.toolCalls,
        createdAt: nowIso(),
      });
    return result;
  } finally {
    release();
  }
}
