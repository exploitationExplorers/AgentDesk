/**
 * FSRS（Free Spaced Repetition Scheduler）调度核心。
 *
 * 实现的是 FSRS-5 的公式与官方发布的默认权重。只做调度计算，不碰数据库，
 * 方便单独测试。尚未实现「个性化权重优化」——那一步需要累积足够的真实复习
 * 记录后在本地重新拟合 W，属于后续工作。
 *
 * 注意：下面的 DEFAULT_W 取自 FSRS-5 公开的默认参数。上线前应与上游
 * open-spaced-repetition/fsrs4anki 的当前版本再核对一次，避免参数漂移。
 */

/** 评分：1 忘记、2 困难、3 一般、4 容易。 */
export type Rating = 1 | 2 | 3 | 4;

export const DEFAULT_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
] as const;

const DECAY = -0.5;
/** 使 R(S, S) = 0.9 成立的常数。 */
const FACTOR = 19 / 81;

export interface MemoryState {
  /** 稳定性 S，单位「天」：可提取性衰减到 90% 所需的时间。 */
  stability: number;
  /** 难度 D，1–10。 */
  difficulty: number;
}

/** 间隔 t 天之后，这条内容还能被回忆起来的概率。 */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  return Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);
}

/** 给定目标保持率，算出下次复习应该间隔多少天。 */
export function intervalFor(stability: number, desiredRetention: number): number {
  const r = Math.min(0.99, Math.max(0.7, desiredRetention));
  return (stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1);
}

const clampD = (d: number) => Math.min(10, Math.max(1, d));

/** 首次复习后的初始记忆状态。 */
export function initialState(rating: Rating, w: readonly number[] = DEFAULT_W): MemoryState {
  return {
    stability: Math.max(0.1, w[rating - 1]!),
    difficulty: clampD(w[4]! - Math.exp(w[5]! * (rating - 1)) + 1),
  };
}

function nextDifficulty(d: number, rating: Rating, w: readonly number[]): number {
  const delta = -w[6]! * (rating - 3);
  const damped = d + (delta * (10 - d)) / 9;
  // 向「评分为 4 时的初始难度」做均值回归，避免难度单调漂移。
  const target = w[4]! - Math.exp(w[5]! * 3) + 1;
  return clampD(w[7]! * target + (1 - w[7]!) * damped);
}

function stabilityAfterRecall(
  s: number,
  d: number,
  r: number,
  rating: Rating,
  w: readonly number[],
): number {
  const hardPenalty = rating === 2 ? w[15]! : 1;
  const easyBonus = rating === 4 ? w[16]! : 1;
  return (
    s *
    (1 +
      Math.exp(w[8]!) *
        (11 - d) *
        Math.pow(s, -w[9]!) *
        (Math.exp(w[10]! * (1 - r)) - 1) *
        hardPenalty *
        easyBonus)
  );
}

function stabilityAfterLapse(s: number, d: number, r: number, w: readonly number[]): number {
  return w[11]! * Math.pow(d, -w[12]!) * (Math.pow(s + 1, w[13]!) - 1) * Math.exp(w[14]! * (1 - r));
}

export interface ScheduleResult extends MemoryState {
  /** 距离下次复习的天数（已按 desiredRetention 计算）。 */
  intervalDays: number;
  /** 本次复习时这条内容的可提取性，用于写入复习日志。 */
  retrievability: number;
}

/**
 * 根据本次评分推进记忆状态。
 *
 * @param prev 之前的状态；`null` 表示这是第一次复习。
 * @param elapsedDays 距离上次复习过去了多少天。
 */
export function schedule(
  prev: MemoryState | null,
  rating: Rating,
  elapsedDays: number,
  desiredRetention = 0.9,
  w: readonly number[] = DEFAULT_W,
): ScheduleResult {
  if (!prev) {
    const init = initialState(rating, w);
    return {
      ...init,
      retrievability: 1,
      intervalDays: Math.max(1, Math.round(intervalFor(init.stability, desiredRetention))),
    };
  }
  const r = retrievability(elapsedDays, prev.stability);
  const difficulty = nextDifficulty(prev.difficulty, rating, w);
  const stability =
    rating === 1
      ? stabilityAfterLapse(prev.stability, prev.difficulty, r, w)
      : stabilityAfterRecall(prev.stability, prev.difficulty, r, rating, w);
  const safe = Math.max(0.1, stability);
  return {
    stability: safe,
    difficulty,
    retrievability: r,
    intervalDays: Math.max(1, Math.round(intervalFor(safe, desiredRetention))),
  };
}
