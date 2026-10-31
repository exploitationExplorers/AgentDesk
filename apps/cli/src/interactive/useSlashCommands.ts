import { useEffect, useRef, useState } from "react";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentModelBinding,
  AgentName,
  Approval,
  Conversation,
  HealthInfo,
  Memory,
  ModelSelection,
  Provider,
  Task,
} from "@agentdesk/shared";
import type { apiRequest as ApiRequest, ApiState } from "../client.js";
import type { CommandPanelData } from "./CommandPanel.js";
import type { HistoryMessage } from "./types.js";
import type { AccessibilityTheme } from "./theme.js";
import {
  defaultModelOption,
  modelOptions,
  parseSlashCommand,
  SLASH_COMMANDS,
} from "./slash-commands.js";

const AGENT_OPTIONS: { name: AgentName; description: string }[] = [
  { name: "orchestrator", description: "总控助手，自动委派任务" },
  { name: "code", description: "编码助手" },
  { name: "project", description: "项目管理" },
  { name: "deploy", description: "部署助手" },
  { name: "research", description: "研究助手" },
  { name: "reviewer", description: "代码审查" },
];

interface Options {
  state: ApiState;
  apiRequest: typeof ApiRequest;
  initialAgent?: AgentName;
  initialModel?: string;
  initialTheme: AccessibilityTheme;
  conversationId: string | null;
  cwd: string;
  version: string;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  onNew: () => void;
  onResume: (id: string, messages: HistoryMessage[]) => void;
  onResult: (command: string, result: string) => void;
  onExit: () => void;
}

export function useSlashCommands(options: Options) {
  const { state, apiRequest, conversationId, cwd, version, onResult } = options;
  const [agent, setAgent] = useState<AgentName>(options.initialAgent ?? "orchestrator");
  const [selection, setSelection] = useState<ModelSelection>();
  const [modelLabel, setModelLabel] = useState(options.initialModel ?? "默认模型");
  const [theme, setTheme] = useState(options.initialTheme);
  const [panel, setPanel] = useState<CommandPanelData | null>(null);
  const [loading, setLoading] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
    };
  }, []);

  function cancel() {
    operation.current?.abort();
    operation.current = null;
    setLoading(false);
    setPanel(null);
  }

  async function runAction(command: string, action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setLoading(true);
    try {
      await action(controller.signal);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setPanel(null);
        onResult(command, `执行失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (mounted.current && operation.current === controller) {
        operation.current = null;
        setLoading(false);
      }
    }
  }

  function show(title: string, lines: string[]) {
    setPanel({ title, lines });
  }

  function chooseModel(command: string, value: ModelSelection | undefined, label: string) {
    setSelection(value);
    setModelLabel(label);
    setPanel(null);
    onResult(command, value ? `当前会话已切换到 ${label}。` : `已恢复默认模型：${label}。`);
  }

  async function execute(input: string) {
    const parsed = parseSlashCommand(input);
    if (!parsed) return false;
    await runAction(input, async (signal) => {
      async function get<T>(path: string, init?: RequestInit): Promise<T> {
        const response = await apiRequest<T>(state, path, { ...init, signal });
        const result = await response.json();
        signal.throwIfAborted();
        return result;
      }
      const { command, args } = parsed;
      if (!command) {
        onResult(input, `未知指令 /${parsed.name}。输入 /help 查看可用指令。`);
        return;
      }
      if (["help", "--help", "-h"].includes(args)) {
        show(`/${command.name}`, [
          command.description,
          `用法：/${command.name} ${command.args ?? ""}`,
        ]);
        return;
      }
      const info = (text: string) => onResult(input, text);
      const history = () =>
        conversationId
          ? get<HistoryMessage[]>(`/conversations/${encodeURIComponent(conversationId)}/messages`)
          : Promise.resolve<HistoryMessage[]>([]);
      switch (command.name) {
        case "help": {
          const matching = args
            ? SLASH_COMMANDS.filter(
                (item) =>
                  item.name === args.replace(/^\//, "") ||
                  item.aliases?.includes(args.replace(/^\//, "")),
              )
            : SLASH_COMMANDS;
          show("命令与快捷键", [
            ...matching.map(
              (item) =>
                `/${item.name}${item.args ? ` ${item.args}` : ""} — ${item.description}${item.aliases ? `（${item.aliases.map((alias) => `/${alias}`).join("、")}）` : ""}`,
            ),
            ...(matching.length ? [] : [`未找到命令 ${args}。`]),
            "输入 / 打开菜单；Tab 补全；↑↓ 选择命令或浏览输入历史。",
            "Esc 关闭菜单或中断回复；Ctrl+C 清空输入 / 中断 / 退出。",
            "Ctrl+O 展开工具详情；Tab 在执行时进入步骤导航。",
          ]);
          break;
        }
        case "model": {
          const [providers, bindings] = await Promise.all([
            get<Provider[]>("/providers"),
            get<AgentModelBinding[]>("/agent-bindings"),
          ]);
          const fallback = defaultModelOption(providers, bindings, agent);
          if (args === "default") {
            chooseModel(input, undefined, fallback?.model ?? "未配置");
            break;
          }
          if (["info", "status"].includes(args)) {
            info(
              `当前模型：${selection ? `${selection.model}（${selection.providerId}）` : `${fallback?.model ?? "未配置"}（默认）`}`,
            );
            break;
          }
          const warnings: string[] = [];
          if (args === "refresh") {
            await Promise.all(
              providers
                .filter((provider) => provider.enabled && provider.hasKey)
                .map(async (provider) => {
                  try {
                    const remote = await get<string[]>(
                      `/providers/${encodeURIComponent(provider.id)}/remote-models`,
                    );
                    provider.models = [...new Set([...provider.models, ...remote])];
                  } catch (error) {
                    signal.throwIfAborted();
                    warnings.push(
                      `${provider.name}：${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                }),
            );
          }
          const models = modelOptions(providers, bindings);
          if (!models.length)
            throw new Error(
              "没有可用模型。请先运行 agentdesk init，或在工作台配置并启用 Provider 和 API Key。",
            );
          if (args && args !== "refresh") {
            let matches = models.filter(
              (item) =>
                item.model === args ||
                `${item.providerId}/${item.model}` === args ||
                `${item.providerName}/${item.model}` === args,
            );
            if (matches.length > 1)
              throw new Error(
                "多个 Provider 提供同名模型，请用 /model providerId/模型 指定，或从 /model 菜单选择。",
              );
            if (!matches.length) {
              const provider = providers.find(
                (item) =>
                  item.enabled &&
                  item.hasKey &&
                  (args.startsWith(`${item.id}/`) || args.startsWith(`${item.name}/`)),
              );
              const prefix = provider
                ? args.startsWith(`${provider.id}/`)
                  ? provider.id
                  : provider.name
                : undefined;
              const target =
                provider ??
                providers.find(
                  (item) => item.id === (selection?.providerId ?? fallback?.providerId),
                );
              const customModel = prefix ? args.slice(prefix.length + 1) : args;
              if (
                !target?.enabled ||
                !target.hasKey ||
                !customModel ||
                /\s/.test(customModel) ||
                customModel.length > 256
              )
                throw new Error("模型格式无效，请使用 /model providerId/模型。");
              matches = [{ providerId: target.id, providerName: target.name, model: customModel }];
            }
            const selected = matches[0]!;
            chooseModel(
              input,
              { providerId: selected.providerId, model: selected.model },
              `${selected.model} · ${selected.providerName}`,
            );
            break;
          }
          if (warnings.length)
            info(`部分 Provider 刷新失败，已保留已配置的模型：\n${warnings.join("\n")}`);
          setPanel({
            title: `选择模型 · 当前 ${selection?.model ?? fallback?.model ?? modelLabel}`,
            items: [
              {
                id: "default",
                label: "默认模型",
                detail: fallback ? `${fallback.model} · ${fallback.providerName}` : "未配置",
                current: !selection,
              },
              ...models.map((item, index) => ({
                id: String(index),
                label: item.model,
                detail: `${item.providerName} · ${item.providerId}`,
                current:
                  selection?.providerId === item.providerId && selection.model === item.model,
              })),
            ],
            onSelect: (id) => {
              if (id === "default") chooseModel(input, undefined, fallback?.model ?? "未配置");
              else {
                const item = models[Number(id)];
                if (item)
                  chooseModel(
                    input,
                    { providerId: item.providerId, model: item.model },
                    `${item.model} · ${item.providerName}`,
                  );
              }
            },
          });
          break;
        }
        case "clear":
          options.onNew();
          info("已开始新会话。历史会话可通过 /resume 恢复。");
          break;
        case "resume": {
          const list = (await get<Conversation[]>("/conversations")).sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          );
          const matches = args
            ? list.filter(
                (item) => item.id === args || item.title.toLowerCase().includes(args.toLowerCase()),
              )
            : list;
          const resume = async (id: string, resumeSignal: AbortSignal) => {
            const messages = await (
              await apiRequest<HistoryMessage[]>(
                state,
                `/conversations/${encodeURIComponent(id)}/messages`,
                { signal: resumeSignal },
              )
            ).json();
            resumeSignal.throwIfAborted();
            options.onResume(id, messages);
            setPanel(null);
          };
          if (!matches.length) {
            info(args ? "没有匹配的历史会话。" : "暂无历史会话。");
            break;
          }
          const exact = args
            ? (matches.find((item) => item.id === args) ??
              (matches.length === 1 ? matches[0] : undefined))
            : undefined;
          if (exact) await resume(exact.id, signal);
          else
            setPanel({
              title: "恢复会话",
              items: matches.map((item) => ({
                id: item.id,
                label: item.title,
                detail: item.id,
                current: item.id === conversationId,
              })),
              onSelect: (id) => runAction(input, (resumeSignal) => resume(id, resumeSignal)),
            });
          break;
        }
        case "rename":
          if (!conversationId) throw new Error("请先开始一轮对话，再重命名会话。");
          if (!args) throw new Error("用法：/rename <标题>");
          await get(`/conversations/${encodeURIComponent(conversationId)}`, {
            method: "PATCH",
            body: JSON.stringify({ title: args }),
          });
          info(`会话已重命名为：${args}`);
          break;
        case "agents": {
          const [providers, bindings] = await Promise.all([
            get<Provider[]>("/providers"),
            get<AgentModelBinding[]>("/agent-bindings"),
          ]);
          const choose = (id: string) => {
            const found = AGENT_OPTIONS.find((item) => item.name === id);
            if (!found) throw new Error(`未知 Agent：${id}`);
            setAgent(found.name);
            if (!selection)
              setModelLabel(defaultModelOption(providers, bindings, found.name)?.model ?? "未配置");
            setPanel(null);
            info(`当前 Agent：${found.name} · ${found.description}`);
          };
          if (args) choose(args);
          else
            setPanel({
              title: "选择 Agent",
              items: AGENT_OPTIONS.map((item) => ({
                id: item.name,
                label: item.name,
                detail: item.description,
                current: item.name === agent,
              })),
              onSelect: choose,
            });
          break;
        }
        case "config": {
          const values = {
            color: theme.color,
            motion: theme.motion,
            emoji: theme.emoji,
            verbose: options.expanded,
          };
          const apply = (key: string, enabled: boolean) => {
            if (key === "verbose") options.setExpanded(enabled);
            else if (key === "color" || key === "motion" || key === "emoji")
              setTheme((current) => ({ ...current, [key]: enabled }));
            setPanel(null);
            info(`${key} 已${enabled ? "开启" : "关闭"}（当前终端）。`);
          };
          if (args) {
            const [key, value, extra] = args.split(/\s+/);
            if (!key || !(key in values) || !["on", "off"].includes(value ?? "") || extra)
              throw new Error("用法：/config <color | motion | emoji | verbose> <on | off>");
            apply(key, value === "on");
          } else
            setPanel({
              title: "终端设置 · Enter 切换",
              items: Object.entries(values).map(([key, value]) => ({
                id: key,
                label: key,
                detail: value ? "on" : "off",
              })),
              onSelect: (key) => apply(key, !values[key as keyof typeof values]),
            });
          break;
        }
        case "theme": {
          const choose = (id: string) => {
            if (id !== "plain" && id !== "default")
              throw new Error("用法：/theme [default | plain]");
            setTheme(
              id === "plain"
                ? { ...theme, color: false, motion: false, emoji: false }
                : options.initialTheme,
            );
            setPanel(null);
            info(`终端主题：${id}`);
          };
          if (args) choose(args);
          else
            setPanel({
              title: "终端主题",
              items: [
                { id: "default", label: "默认", detail: "遵循启动参数和环境设置" },
                { id: "plain", label: "纯文本", detail: "关闭配色、动画与 Emoji" },
              ],
              onSelect: choose,
            });
          break;
        }
        case "status": {
          const health = await get<HealthInfo>("/health");
          show("当前状态", [
            `AgentDesk v${version} · 服务 v${health.version}`,
            `会话：${conversationId ?? "新会话"}`,
            `Agent：${agent}`,
            `模型：${modelLabel}${selection ? "（当前会话）" : "（默认）"}`,
            `工作目录：${cwd}`,
            `服务：${health.ok ? "正常" : "异常"}`,
            `Provider：${health.providers} 个`,
            `数据目录：${health.dataDir}`,
          ]);
          break;
        }
        case "context": {
          const messages = await history();
          show("会话上下文", [
            `会话：${conversationId ?? "新会话"}`,
            `消息：${messages.length} 条`,
            `正文：${messages.reduce((count, item) => count + item.content.length, 0)} 字符`,
            `工具调用：${messages.reduce((count, item) => count + (item.toolCalls?.length ?? 0), 0)} 次`,
            `模型：${modelLabel}`,
            "此处统计已保存的会话内容，不包含系统提示和自动召回的记忆。",
            "使用 /clear 开始新上下文，使用 /resume 恢复历史。",
          ]);
          break;
        }
        case "permissions": {
          const [approvals, tools] = await Promise.all([
            get<Approval[]>("/approvals?status=pending"),
            get<{ name: string; risk: string }[]>("/tools"),
          ]);
          show("工具权限与审批", [
            "safe：可直接执行；confirm / dangerous：按工具策略请求审批。",
            "审批出现时按 y 允许、n 拒绝。",
            `待审批：${approvals.length} 条`,
            ...approvals.map((item) => `${item.id} · ${item.title}`),
            ...tools.map((tool) => `${tool.name} · ${tool.risk}`),
          ]);
          break;
        }
        case "tools": {
          const tools = await get<{ name: string; description: string; risk: string }[]>("/tools");
          show(
            "可用工具",
            tools
              .filter((item) =>
                `${item.name} ${item.description}`.toLowerCase().includes(args.toLowerCase()),
              )
              .map((item) => `${item.name} [${item.risk}] ${item.description}`),
          );
          break;
        }
        case "skills": {
          const skills = await get<{ name: string; description: string }[]>("/skills");
          show(
            "已加载的 Skills",
            skills
              .filter((item) =>
                `${item.name} ${item.description}`.toLowerCase().includes(args.toLowerCase()),
              )
              .map((item) => `${item.name} — ${item.description}`),
          );
          break;
        }
        case "tasks": {
          const tasks = await get<Task[]>(
            `/tasks${args ? `?status=${encodeURIComponent(args)}` : ""}`,
          );
          show(
            "后台任务",
            tasks.map((task) => `${task.id} [${task.status}] ${task.title}`),
          );
          break;
        }
        case "memory": {
          const memories = await get<Memory[]>("/memories");
          show(
            "长期记忆",
            memories
              .filter((item) => item.text.toLowerCase().includes(args.toLowerCase()))
              .map((item) => `[${item.kind}] ${item.text}`),
          );
          break;
        }
        case "export": {
          const messages = await history();
          if (!messages.length) throw new Error("当前会话没有可导出的消息。");
          const file = resolve(
            cwd,
            args.replace(/^(["'])(.*)\1$/, "$2") || `agentdesk-${conversationId}.md`,
          );
          const content = [
            `# AgentDesk 会话 ${conversationId}`,
            ...messages.map(
              (message) =>
                `## ${message.role === "user" ? "用户" : "助手"}\n\n${message.content}${message.toolCalls?.length ? `\n\n工具记录：\n\n\`\`\`json\n${JSON.stringify(message.toolCalls, null, 2)}\n\`\`\`` : ""}`,
            ),
          ].join("\n\n");
          await writeFile(file, `${content}\n`, { encoding: "utf8", flag: "wx", signal });
          signal.throwIfAborted();
          info(`会话已导出：${file}`);
          break;
        }
        case "doctor": {
          const [health, providers] = await Promise.all([
            get<HealthInfo>("/health"),
            get<Provider[]>("/providers"),
          ]);
          show("环境诊断", [
            `Node.js：${process.version}`,
            `服务连接：${health.ok ? "正常" : "异常"}`,
            `密钥存储：${health.secretBackend}`,
            `可用 Provider：${providers.filter((provider) => provider.enabled && provider.hasKey).length}`,
            ...providers.map(
              (provider) =>
                `${provider.name}：${!provider.enabled ? "停用" : !provider.hasKey ? "缺少 API Key" : "已配置"}`,
            ),
            "未发起模型推理请求；配置模型可运行 agentdesk init。",
          ]);
          break;
        }
        case "version":
          info(`AgentDesk v${version}`);
          break;
        case "exit":
          options.onExit();
          break;
      }
    });
    return true;
  }

  return { agent, selection, modelLabel, theme, panel, loading, execute, cancel };
}
