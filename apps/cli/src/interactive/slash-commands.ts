import type { AgentModelBinding, AgentName, ModelSelection, Provider } from "@agentdesk/shared";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", aliases: ["?"], description: "查看命令与快捷键", args: "[命令]" },
  {
    name: "model",
    description: "选择当前会话的模型",
    args: "[模型 | provider/模型 | default | refresh]",
  },
  { name: "clear", aliases: ["new", "reset"], description: "清空当前上下文并开始新会话" },
  { name: "resume", aliases: ["continue"], description: "恢复历史会话", args: "[会话 ID 或标题]" },
  { name: "rename", description: "重命名当前会话", args: "<标题>" },
  { name: "agents", aliases: ["agent"], description: "选择当前会话的 Agent", args: "[名称]" },
  {
    name: "config",
    aliases: ["settings"],
    description: "调整终端显示设置",
    args: "[color | motion | emoji | verbose] [on | off]",
  },
  { name: "theme", description: "切换终端配色", args: "[default | plain]" },
  { name: "status", description: "查看当前模型、会话与服务状态" },
  { name: "context", description: "查看当前会话的上下文统计" },
  { name: "permissions", aliases: ["approvals"], description: "查看工具权限与待处理审批" },
  { name: "tools", description: "查看可用工具及风险等级", args: "[搜索词]" },
  { name: "skills", description: "查看已加载的 Skills", args: "[搜索词]" },
  { name: "tasks", description: "查看后台任务", args: "[状态]" },
  { name: "memory", description: "查看长期记忆", args: "[搜索词]" },
  { name: "export", description: "将当前会话导出为 Markdown", args: "[文件路径]" },
  { name: "doctor", description: "检查服务连接与模型配置" },
  { name: "version", description: "查看 CLI 版本" },
  { name: "exit", aliases: ["quit"], description: "退出终端会话" },
];

export function parseSlashCommand(input: string) {
  const match = /^\/([^\s]*)\s*([\s\S]*)$/.exec(input.trim());
  if (!match) return null;
  const name = (match[1] ?? "").toLowerCase();
  return {
    name,
    args: (match[2] ?? "").trim(),
    command: SLASH_COMMANDS.find(
      (command) => command.name === name || command.aliases?.includes(name),
    ),
  };
}

export function commandSuggestions(input: string): SlashCommand[] {
  if (!/^\/[^\s]*$/.test(input)) return [];
  const query = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter((command) =>
    [command.name, ...(command.aliases ?? [])].some((name) => name.startsWith(query)),
  );
}

export interface ModelOption extends ModelSelection {
  providerName: string;
}

export function modelOptions(
  providers: Provider[],
  bindings: AgentModelBinding[] = [],
): ModelOption[] {
  return providers
    .filter((provider) => provider.enabled && provider.hasKey)
    .flatMap((provider) =>
      [
        ...new Set([
          provider.defaultModel,
          ...provider.models,
          ...bindings
            .filter((binding) => binding.providerId === provider.id)
            .map((binding) => binding.model),
        ]),
      ]
        .filter(Boolean)
        .map((model) => ({ providerId: provider.id, providerName: provider.name, model })),
    );
}

/** 与服务端默认解析顺序一致，跳过停用或没有密钥的 Provider。 */
export function defaultModelOption(
  providers: Provider[],
  bindings: AgentModelBinding[],
  agent: AgentName,
): ModelOption | undefined {
  const binding =
    bindings.find((item) => item.agent === agent) ??
    bindings.find((item) => item.agent === "orchestrator");
  const available = providers.filter((provider) => provider.enabled && provider.hasKey);
  const primary = available.find((provider) => provider.id === binding?.providerId);
  const provider =
    primary ??
    binding?.fallbackProviderIds
      .map((id) => available.find((item) => item.id === id))
      .find(Boolean) ??
    available[0];
  if (!provider) return undefined;
  return {
    providerId: provider.id,
    providerName: provider.name,
    model: primary && binding ? binding.model : provider.defaultModel,
  };
}
