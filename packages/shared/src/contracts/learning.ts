import { z } from "zod";

/** 技能分类：硬实力、软实力、语言能力。 */
export const SkillCategory = z.enum(["hard", "soft", "language"]);
export type SkillCategory = z.infer<typeof SkillCategory>;

/**
 * 由 career-profiler 产出的一条技能「建议」。
 * 注意这是建议，不是对用户能力的测评结果——真实水平来自后续练习留下的证据。
 */
export const SkillSuggestion = z.object({
  name: z.string(),
  category: SkillCategory,
  reason: z.string(),
  /** 该技能对这个职业的重要度，1–5。 */
  weight: z.number().int().min(1).max(5),
});
export type SkillSuggestion = z.infer<typeof SkillSuggestion>;

/** 技能建议的来源：真实模型调用，还是无可用模型时的内置职业模板。 */
export const SuggestionOrigin = z.enum(["model", "builtin"]);
export type SuggestionOrigin = z.infer<typeof SuggestionOrigin>;

export const SkillSuggestionResult = z.object({
  profession: z.string(),
  origin: SuggestionOrigin,
  skills: z.array(SkillSuggestion),
});
export type SkillSuggestionResult = z.infer<typeof SkillSuggestionResult>;

/** 一个职业画像。同一个人可以有多个画像（例如同时想提升职业英语和算法）。 */
export const LearningProfile = z.object({
  id: z.string(),
  profession: z.string(),
  targetRole: z.string().nullable(),
  /** 每日可投入的学习时间（分钟）。 */
  dailyBudgetMin: z.number().int().positive(),
  createdAt: z.string(),
});
export type LearningProfile = z.infer<typeof LearningProfile>;

export const LearningProfileInput = z.object({
  profession: z.string().min(1),
  targetRole: z.string().nullable().optional(),
  dailyBudgetMin: z.number().int().positive().default(30),
});
export type LearningProfileInput = z.infer<typeof LearningProfileInput>;

export const PlanStatus = z.enum(["draft", "active", "paused", "completed", "abandoned"]);
export type PlanStatus = z.infer<typeof PlanStatus>;

/** 计划的一个里程碑，属于某个计划版本的不可变快照的一部分。 */
export const Milestone = z.object({
  label: z.string(),
  focus: z.string(),
});
export type Milestone = z.infer<typeof Milestone>;

export const LearningPlan = z.object({
  id: z.string(),
  profileId: z.string(),
  skillName: z.string(),
  status: PlanStatus,
  goal: z.string(),
  milestones: z.array(Milestone),
  /** 计划跨度（天）。 */
  durationDays: z.number().int().positive(),
  currentVersionId: z.string(),
  createdAt: z.string(),
});
export type LearningPlan = z.infer<typeof LearningPlan>;

export const LearningPlanInput = z.object({
  profileId: z.string(),
  skillName: z.string().min(1),
  durationDays: z.number().int().positive().default(28),
});
export type LearningPlanInput = z.infer<typeof LearningPlanInput>;

export const ActivityType = z.enum(["reading", "practice", "quiz", "review"]);
export type ActivityType = z.infer<typeof ActivityType>;

export const ActivityStatus = z.enum(["pending", "done", "skipped"]);
export type ActivityStatus = z.infer<typeof ActivityStatus>;

/** 某一天里一件具体要做的事。 */
export const LearningActivity = z.object({
  id: z.string(),
  planId: z.string(),
  planVersionId: z.string(),
  /** 本地日期，YYYY-MM-DD。 */
  date: z.string(),
  orderIndex: z.number().int(),
  title: z.string(),
  detail: z.string(),
  type: ActivityType,
  estMinutes: z.number().int().positive(),
  status: ActivityStatus,
  completedAt: z.string().nullable(),
});
export type LearningActivity = z.infer<typeof LearningActivity>;

/** 某个自然日的打卡聚合，只有产生过有效学习会话才计入。 */
export const Checkin = z.object({
  date: z.string(),
  effectiveMinutes: z.number().int(),
  activitiesDone: z.number().int(),
});
export type Checkin = z.infer<typeof Checkin>;

/** 「今日学习」页需要的全部数据，一次取回。 */
export const LearningToday = z.object({
  date: z.string(),
  profile: LearningProfile.nullable(),
  plan: LearningPlan.nullable(),
  activities: z.array(LearningActivity),
  /** 昨天完成了什么，用于「昨日回顾」。 */
  yesterday: z.object({
    date: z.string(),
    done: z.number().int(),
    total: z.number().int(),
    minutes: z.number().int(),
    titles: z.array(z.string()),
  }),
  /** 连续有效学习天数。 */
  streak: z.number().int(),
  /** 最近若干天的打卡记录，用于热力图。 */
  checkins: z.array(Checkin),
  /** 今天到期的复习条数，用于在今日页提示。 */
  dueReviews: z.number().int(),
});
export type LearningToday = z.infer<typeof LearningToday>;

// ---------- 资料导入 ----------

export const SourceKind = z.enum(["url", "text"]);
export type SourceKind = z.infer<typeof SourceKind>;

/** 一份导入的学习资料，附带最新版本的统计信息。 */
export const LearningSource = z.object({
  id: z.string(),
  kind: SourceKind,
  originRef: z.string(),
  title: z.string(),
  currentVersionId: z.string(),
  createdAt: z.string(),
  charCount: z.number().int(),
  blockCount: z.number().int(),
  /** ok 正常；partial 表示可能有内容没解析出来，界面要如实说明。 */
  parseQuality: z.enum(["ok", "partial"]),
  unitCount: z.number().int(),
});
export type LearningSource = z.infer<typeof LearningSource>;

export const ImportSourceInput = z
  .object({
    url: z.string().url().optional(),
    /** 直接粘贴正文。抓取被拒时的降级路径。 */
    text: z.string().min(50).optional(),
    title: z.string().optional(),
  })
  .refine((v) => !!v.url || !!v.text, { message: "需要提供链接或正文" });
export type ImportSourceInput = z.infer<typeof ImportSourceInput>;

/** 从资料里提炼出的一个知识点，必须能回溯到原文内容块。 */
export const KnowledgeUnit = z.object({
  id: z.string(),
  sourceVersionId: z.string(),
  blockId: z.string(),
  orderIndex: z.number().int(),
  title: z.string(),
  summary: z.string(),
  question: z.string(),
  answer: z.string(),
  /** 该知识点所依据的原文片段。 */
  sourceText: z.string(),
});
export type KnowledgeUnit = z.infer<typeof KnowledgeUnit>;

// ---------- 复习 ----------

export const ReviewRating = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type ReviewRating = z.infer<typeof ReviewRating>;

/** 复习队列里的一项。 */
export const ReviewCard = z.object({
  itemId: z.string(),
  unit: KnowledgeUnit,
  sourceTitle: z.string(),
  dueDate: z.string(),
  reps: z.number().int(),
  lapses: z.number().int(),
  stability: z.number().nullable(),
  difficulty: z.number().nullable(),
  /** 当前可提取性，0–1；没复习过时为 null。 */
  retrievability: z.number().nullable(),
  /** 是不是今天之前就该复习的。 */
  overdue: z.boolean(),
});
export type ReviewCard = z.infer<typeof ReviewCard>;

export const ReviewQueue = z.object({
  date: z.string(),
  cards: z.array(ReviewCard),
  /** 全部知识点数量，以及其中已经到期的数量。 */
  totalUnits: z.number().int(),
  dueCount: z.number().int(),
  newCount: z.number().int(),
});
export type ReviewQueue = z.infer<typeof ReviewQueue>;

/** 评分后返回的调度结果，界面用它告诉用户下次什么时候再见。 */
export const GradeResult = z.object({
  itemId: z.string(),
  stability: z.number(),
  difficulty: z.number(),
  intervalDays: z.number().int(),
  dueDate: z.string(),
});
export type GradeResult = z.infer<typeof GradeResult>;
