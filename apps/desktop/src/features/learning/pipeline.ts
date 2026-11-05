import type { RouteFlowStep, RouteFlowTarget } from "@agentdesk/ui";

/**
 * 成长中心的能力插件清单与管道脚本。
 *
 * 定义在模块级别而不是组件内，这样引用是稳定的 —— RouteFlow 的动画 effect 依赖
 * targets/steps 的身份，每次渲染都新建数组会让动画不停重启。
 */
export const PLUGINS: RouteFlowTarget[] = [
  { id: "career-profiler", label: "职业画像", meta: "career-profiler" },
  { id: "course-builder", label: "课程构建", meta: "course-builder" },
  { id: "coach", label: "学习教练", meta: "coach" },
  { id: "quiz-master", label: "出题器", meta: "quiz-master" },
  { id: "review-scheduler", label: "复习调度", meta: "review-scheduler" },
  { id: "evaluator", label: "评测器", meta: "evaluator" },
];

/** 「选职业 → 生成计划」这条链路，对应 CareerMapPage 上正在发生的事。 */
export const CAREER_STEPS: RouteFlowStep[] = [
  {
    targetId: "career-profiler",
    chip: "画像中",
    result: "技能建议",
    caption:
      "career-profiler 根据职业给出硬实力 / 软实力建议。这是面向职业的通用建议，不是对你个人的能力测评。",
  },
  {
    targetId: "course-builder",
    chip: "生成计划",
    result: "里程碑",
    caption: "course-builder 把你选中的那项能力拆成阶段里程碑，并写出今天就能开始做的任务。",
  },
  {
    targetId: "review-scheduler",
    chip: "排复习",
    result: "入队",
    caption: "review-scheduler 为新内容建立复习节奏。这一步是纯算法，不调用模型，断网也能跑。",
  },
];

/** 「每日学习」链路，对应 OverviewPage。 */
export const TODAY_STEPS: RouteFlowStep[] = [
  {
    targetId: "review-scheduler",
    chip: "算队列",
    result: "今日队列",
    caption: "先算出今天该复习什么：错题优先，临期其次。纯计算，打开就有，不等模型。",
  },
  {
    targetId: "coach",
    chip: "讲解",
    result: "带引用",
    caption:
      "卡住时 coach 给出带原文引用的讲解；检索不到依据时会直说「没有找到对应资料」，不会编。",
  },
  {
    targetId: "evaluator",
    chip: "判定",
    result: "三种证据",
    caption: "evaluator 区分独立通过 / 提示后通过 / 跨日验证，只有「独立 + 跨日」才算真正掌握。",
  },
];
