import { Box, Text } from "ink";
import ApprovalCard from "./ApprovalCard.js";
import StepRow from "./StepRow.js";
import type { DelegateStep, RunNode, Step, StepViewProps } from "./types.js";

const STATUS_COLOR = {
  queued: "gray",
  running: "cyan",
  succeeded: "green",
  failed: "red",
  cancelled: "yellow",
};
const STATUS_LABEL = {
  queued: "排队中",
  running: "执行中",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
};

// DelegateRunView 与 StepList 原本是互相导入的两个文件：StepList 渲染 delegate 步骤时调用
// DelegateRunView，DelegateRunView 递归渲染子 Run 的步骤列表时又调用 StepList。这个循环引用
// 在原生 ESM（包括 Node 直接跑源码、ink-testing-library 测试）下完全安全，但 esbuild 为了兼容
// yoga-layout 的顶层 await，把整条 ink 依赖链都转成了惰性 async __esm 初始化器——circular import
// 在这种模式下变成 circular await，两个模块互相等待对方的初始化 promise 永远无法落地，CLI 在真实
// 构建产物里会卡死在挂载阶段（"Detected unsettled top-level await"）。合并成同一个文件消除这条
// 跨文件的循环依赖边，递归渲染改为模块内部的函数自引用，对 ESM 求值模型永远安全。
/** 渲染一次 agents.delegate 产生的子 Run：缩进嵌套，递归复用 StepList 支持任意深度的再委派。 */
function DelegateRunView({
  step,
  run,
  expanded,
  theme,
  runsById,
}: StepViewProps & { step: DelegateStep; run?: RunNode }) {
  const status = run?.runStatus ?? "running";
  const color = STATUS_COLOR[status] ?? "cyan";
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2} borderStyle="round" borderColor={color}>
      <Text color={color}>
        {"↳ "}
        <Text bold>{step.agent}</Text>
        {` · ${STATUS_LABEL[status] ?? status}`}
      </Text>
      {run ? (
        <>
          <StepList steps={run.steps} expanded={expanded} theme={theme} runsById={runsById} />
          {run.text ? <Text>{run.text}</Text> : null}
          {run.error ? <Text color="red">{run.error}</Text> : null}
        </>
      ) : null}
    </Box>
  );
}

export default function StepList({
  steps,
  expanded,
  theme,
  stepFocusActive = false,
  focusedStepId = null,
  focusOverrides,
  runsById,
}: StepViewProps & { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {steps.map((step, index) => {
        if (step.kind === "approval")
          return <ApprovalCard key={`approval-${step.approvalId}`} {...step} />;
        // Task 命令专用：委派步骤嵌套渲染对应子 Run 的完整内容，runsById 由 TaskView 提供，
        // chat 流程从不产生这种 step，runsById 始终为 undefined，这个分支不会被触及。
        if (step.kind === "delegate")
          return (
            <DelegateRunView
              key={`delegate-${step.runId}`}
              step={step}
              run={runsById?.[step.runId]}
              expanded={expanded}
              theme={theme}
              runsById={runsById}
            />
          );
        const key = step.kind === "tool" ? `tool-${step.id}` : `route-${index}`;
        // 聚焦导航对单行的展开/折叠是相对于全局 expanded 基线的翻转，按 o 切换基线时自动失效。
        const rowExpanded =
          step.kind === "tool" && focusOverrides?.has(step.id) ? !expanded : expanded;
        const focused = stepFocusActive && step.kind === "tool" && step.id === focusedStepId;
        return (
          <StepRow key={key} step={step} expanded={rowExpanded} focused={focused} theme={theme} />
        );
      })}
    </Box>
  );
}
