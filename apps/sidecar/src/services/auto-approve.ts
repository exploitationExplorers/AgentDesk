import type { AutoApprove, ModelResolver } from "@agentdesk/agent-core";
import { classifyShellCommand } from "../agents/bash-classifier";
import { describeRule, type PermissionRuleService } from "./permission-rules";
import type { SettingsService } from "./settings";

function commandOf(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

/**
 * 组装统一的"审批前自动放行"钩子：先查用户记住的规则（deny 优先于 allow，见
 * permission-rules.ts），分类器默认关闭（settings.bashClassifierEnabled），开启后没命中规则且是
 * 高危 shell 命令时再问一次 Bash 分类器。两者都没有意见则回退到正常人工审批。
 */
export function createAutoApprove(
  permissionRules: PermissionRuleService,
  models: ModelResolver,
  settings: SettingsService,
): AutoApprove {
  return async (tool, args, risk) => {
    const rule = permissionRules.match(tool, args);
    if (rule?.decision === "deny") {
      return { approved: false, note: `已记住拒绝：${describeRule(rule)}` };
    }
    if (rule?.decision === "allow") {
      return { approved: true, reason: `命中规则：${describeRule(rule)}`, source: "rule" };
    }

    if (!settings.get().bashClassifierEnabled || tool !== "shell.run" || risk !== "dangerous")
      return { approved: false };
    const command = commandOf(args);
    if (!command) return { approved: false };

    const verdict = await classifyShellCommand(command, models);
    if (verdict.safe) {
      return { approved: true, reason: `AI 判定安全：${verdict.reason}`, source: "classifier" };
    }
    return verdict.reason ? { approved: false, note: verdict.reason } : { approved: false };
  };
}
