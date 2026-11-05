/** 任务进行中的口语气轮播，对齐 WorkBuddy loadingTips：前端本地轮换，不走模型。 */

export const THINKING_TIPS = [
  "正在装得很努力的样子（其实真的很努力）",
  "想法正在换鞋，马上出发",
  "别走，下一秒就是你的",
  "等我一下，我去里面开个小会",
  "脑子转得冒烟了",
  "正在飙脑速",
  "稍等，正在思考的路上狂奔",
  "答案在嘴边，差临门一脚",
  "正在憋大招",
  "快了快了，骗你是小狗",
  "马上揭晓，搬好小板凳",
  "CPU 已起飞，风扇在劝它冷静",
  "正在偷偷打草稿，别偷看",
  "小脑袋瓜正在高速旋转，请勿打扰",
  "答案在炖，火候到了就端给你",
  "我没摸鱼，我在深海捞答案",
  "正在把灵感从被窝里拽起来",
  "别眨眼，奇迹正在加载",
  "我不是在偷懒，我是在蓄力",
  "正在认真想，毕竟糊弄你良心会痛",
  "思路在堵车，我正在指挥交通",
  "差不多了，容我收个尾",
  "好问题，值得好好想想",
  "已经有感觉了，差一点点",
  "让我想一秒，就一秒",
] as const;

export const PRODUCT_TIPS = [
  "复杂任务可以先说清目标、输入和期望输出",
  "需要改代码时，到「编码」页看执行过程和文件差异",
  "常用能力可以沉淀成技能，下次直接复用",
  "多步骤任务拆清楚，比一次丢一大坨更稳",
  "关联项目后，对话会带着仓库上下文继续",
  "生成的 PPT / 文档可以在右侧预览并下载",
  "不确定范围时，先让我问清楚再动手",
  "同一主题多轮追问，比每次新开对话更连贯",
] as const;

export const LOADING_TIP_INITIAL_DELAY_MS = 4_000;
export const LOADING_TIP_ROTATION_MS = 10_000;
export const LOADING_TIPS_DISMISS_KEY = "agentdesk.chat.loadingTips.dismissed";

export function loadingTipsDismissed(): boolean {
  try {
    return localStorage.getItem(LOADING_TIPS_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissLoadingTips(): void {
  try {
    localStorage.setItem(LOADING_TIPS_DISMISS_KEY, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

export function pickNextTip(pool: readonly string[], current: string | null): string {
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0]!;
  let next = pool[Math.floor(Math.random() * pool.length)]!;
  if (next === current) {
    const others = pool.filter((tip) => tip !== current);
    next = others[Math.floor(Math.random() * others.length)] ?? next;
  }
  return next;
}

/** 思考语气为主，偶尔夹一条产品提示，避免一直推销。 */
export function tipPool(): string[] {
  const tips: string[] = [...THINKING_TIPS];
  for (const tip of PRODUCT_TIPS) {
    if (Math.random() < 0.35) tips.push(tip);
  }
  return tips;
}
