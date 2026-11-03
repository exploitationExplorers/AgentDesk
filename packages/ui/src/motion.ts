export { AnimatePresence, motion } from "motion/react";
import type { Transition, Variants } from "motion/react";

/**
 * 共享动效词汇表：按语义角色分类（转场/加载态/实时态/反馈态），而不是按视觉效果命名，
 * 新组件统一从这里取 variants，不再各写各的 CSS transition。和 styles.css 里的
 * `fade-in`/`pulse-soft` CSS 关键帧互补：那边管持续循环的效果，这里管状态驱动的进入/离开。
 */

const easeOut: Transition["ease"] = [0.16, 1, 0.3, 1];

/** 转场：浮层/面板/对话框的进入与离开（Dialog、Drawer、下拉菜单等）。 */
export const panelVariants: Variants = {
  hidden: { opacity: 0, scale: 0.98, y: 6 },
  visible: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: easeOut } },
  exit: { opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.12, ease: "easeIn" } },
};

/** 转场：侧边抽屉/侧栏的水平滑入滑出。 */
export const drawerVariants: Variants = {
  hidden: { opacity: 0, x: 24 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.2, ease: easeOut } },
  exit: { opacity: 0, x: 24, transition: { duration: 0.15, ease: "easeIn" } },
};

/** 转场：同一容器内切换内容（成果版本、标签页）时的交叉淡入淡出。 */
export const crossfadeVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.14, ease: easeOut } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: "easeIn" } },
};

/** 转场：列表项增删，配合 `AnimatePresence` 与 `layout` 使用，避免硬切导致的跳动。 */
export const listItemVariants: Variants = {
  hidden: { opacity: 0, height: 0, marginTop: 0, marginBottom: 0 },
  visible: {
    opacity: 1,
    height: "auto",
    transition: { duration: 0.18, ease: easeOut },
  },
  exit: {
    opacity: 0,
    height: 0,
    transition: { duration: 0.14, ease: "easeIn" },
  },
};

/** 转场：网格/卡片列表的增删，不做高度塌缩（网格场景下高度动画会导致错位），只做淡入淡出+轻微缩放。 */
export const gridItemVariants: Variants = {
  hidden: { opacity: 0, scale: 0.97 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.16, ease: easeOut } },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.1, ease: "easeIn" } },
};

/** 反馈：短促确认动效，例如复制成功、保存成功的小弹跳。 */
export const popVariants: Variants = {
  initial: { scale: 0.92, opacity: 0 },
  animate: {
    scale: 1,
    opacity: 1,
    transition: { type: "spring", stiffness: 500, damping: 30 },
  },
  exit: { scale: 0.92, opacity: 0, transition: { duration: 0.1 } },
};

/** 加载态：骨架屏微光扫过，用 backgroundPosition 动画，比纯 CSS keyframes 更容易按内容宽度自适应。 */
export const shimmerTransition: Transition = {
  duration: 1.4,
  ease: "linear",
  repeat: Infinity,
};
