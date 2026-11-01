import { Text } from "ink";
import type { ApprovalReason } from "@agentdesk/shared";
import type { ApprovalStep } from "./types.js";
import type { AccessibilityTheme } from "./theme.js";
import ScrollViewport from "./ScrollViewport.js";
import PermissionDialog from "./PermissionDialog.js";
import Select from "./Select.js";
import BashApproval from "./approval/BashApproval.js";
import FileEditApproval from "./approval/FileEditApproval.js";
import GenericApproval from "./approval/GenericApproval.js";
import { approvalOptionsFor, parseApprovalPayload } from "./approval/payload.js";

function DebugInfo({ reason }: { reason?: ApprovalReason }) {
  const text =
    !reason || reason.type === "default"
      ? "没有命中已保存的规则，按该操作的默认风险等级审批。"
      : `分类器判断仍需确认：${reason.note}`;
  return <Text dimColor>调试：{text}</Text>;
}

function ApprovalBody({
  detail,
  risk,
  payload,
  theme,
}: Pick<ApprovalStep, "detail" | "risk" | "payload"> & { theme: AccessibilityTheme }) {
  const parsed = parseApprovalPayload(payload);
  if (parsed?.tool === "shell.run")
    return <BashApproval args={parsed.args} risk={risk} theme={theme} />;
  if (parsed?.tool === "fs.write" || parsed?.tool === "fs.patch")
    return <FileEditApproval detail={detail} theme={theme} />;
  return <GenericApproval detail={detail} />;
}

export default function ApprovalCard({
  title,
  detail,
  resolved,
  approved,
  risk,
  payload,
  reason,
  maxRows,
  theme,
  focusedIndex = 0,
  debugExpanded = false,
}: Pick<
  ApprovalStep,
  "title" | "detail" | "resolved" | "approved" | "risk" | "payload" | "reason"
> & {
  maxRows?: number;
  theme: AccessibilityTheme;
  focusedIndex?: number;
  debugExpanded?: boolean;
}) {
  if (resolved) {
    return (
      <Text dimColor wrap="truncate-end">
        {approved === undefined ? "· 已处理或已结束" : approved ? "✓ 已批准" : "✗ 已拒绝"} ·{" "}
        {title.replace(/\s+/g, " ")}
      </Text>
    );
  }
  const dialogTitle = parseApprovalPayload(payload)?.tool === "shell.run" ? "执行命令" : title;
  const options = approvalOptionsFor(payload);
  const body = <ApprovalBody detail={detail} risk={risk} payload={payload} theme={theme} />;
  const footer = (
    <Text dimColor wrap="truncate-end">
      Enter 批准 · ↑↓ 选择 · Esc 拒绝（也可直接按 y/n） · Ctrl+D 调试信息
    </Text>
  );
  const debug = debugExpanded ? <DebugInfo reason={reason} /> : null;
  if (maxRows !== undefined) {
    // 固定开销：外壳 marginTop(1) + 顶部分隔线(1) + 标题(1) + Select 选项(options.length) + 底部提示(1)。
    const fixedChrome = 4 + options.length;
    return (
      <PermissionDialog title={dialogTitle} theme={theme}>
        <ScrollViewport maxRows={Math.max(2, maxRows - fixedChrome)} followEnd={false}>
          {body}
        </ScrollViewport>
        <Select options={options} focusedIndex={focusedIndex} theme={theme} />
        {debug}
        {footer}
      </PermissionDialog>
    );
  }
  return (
    <PermissionDialog title={dialogTitle} theme={theme}>
      {body}
      <Select options={options} focusedIndex={focusedIndex} theme={theme} />
      {debug}
      {footer}
    </PermissionDialog>
  );
}
