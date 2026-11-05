import { completeStructured, type ModelResolver } from "@agentdesk/agent-core";
import type {
  ActivityType,
  Checkin,
  LearningActivity,
  LearningPlan,
  LearningPlanInput,
  LearningProfile,
  LearningProfileInput,
  LearningToday,
  Milestone,
  SkillSuggestion,
  SkillSuggestionResult,
} from "@agentdesk/shared";
import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import {
  learningActivities,
  learningCheckins,
  learningPlanVersions,
  learningPlans,
  learningProfiles,
  reviewItems,
} from "../db/schema";
import { newId } from "../util";

/** 本地自然日 YYYY-MM-DD。sidecar 跑在用户本机，所以本地时区就是用户时区。 */
function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y!, m! - 1, d!);
  dt.setDate(dt.getDate() + days);
  return localDate(dt);
}

function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const a = Date.UTC(y1!, m1! - 1, d1!);
  const b = Date.UTC(y2!, m2! - 1, d2!);
  return Math.round((b - a) / 86_400_000);
}

/**
 * 无可用模型时的内置职业技能模板。
 * 这是 career-profiler 声明的降级路径——给出的是通用建议，所以 origin 会标成 builtin，
 * 让界面能如实说明"这不是模型根据你的具体情况分析出来的"。
 */
const BUILTIN_SKILLS: Record<string, SkillSuggestion[]> = {
  前端工程师: [
    {
      name: "TypeScript 与类型建模",
      category: "hard",
      weight: 5,
      reason: "大型前端项目的可维护性基本由类型质量决定",
    },
    {
      name: "浏览器调试与性能分析",
      category: "hard",
      weight: 4,
      reason: "定位线上问题和优化体验的核心手段",
    },
    {
      name: "数据结构与算法",
      category: "hard",
      weight: 3,
      reason: "影响复杂交互的实现质量与面试表现",
    },
    {
      name: "技术英语读写",
      category: "language",
      weight: 4,
      reason: "一手文档、issue 讨论和规范几乎都是英文",
    },
    {
      name: "需求澄清与表达",
      category: "soft",
      weight: 4,
      reason: "前端处在需求、设计、后端的交叉口，沟通成本最高",
    },
  ],
  产品经理: [
    { name: "需求分析与验证", category: "hard", weight: 5, reason: "区分用户说的和用户真正需要的" },
    { name: "指标体系与实验设计", category: "hard", weight: 4, reason: "让决策基于数据而不是直觉" },
    { name: "产品英语", category: "language", weight: 3, reason: "跟进海外竞品与一手行业研究" },
    {
      name: "优先级与取舍沟通",
      category: "soft",
      weight: 5,
      reason: "资源永远不够，解释为什么不做比做更难",
    },
    { name: "跨团队推动", category: "soft", weight: 4, reason: "没有直接汇报关系下仍要把事情推成" },
  ],
  数据分析师: [
    { name: "SQL 与数据建模", category: "hard", weight: 5, reason: "取数质量决定一切结论的可信度" },
    { name: "统计与实验分析", category: "hard", weight: 5, reason: "避免把噪声当成结论" },
    { name: "可视化与叙事", category: "hard", weight: 4, reason: "分析的价值在于被看懂并被采纳" },
    {
      name: "分析报告英语",
      category: "language",
      weight: 3,
      reason: "阅读方法论文献与跨国团队协作",
    },
    { name: "业务理解与提问", category: "soft", weight: 4, reason: "问对问题比算得准更重要" },
  ],
};

const GENERIC_SKILLS: SkillSuggestion[] = [
  { name: "专业核心技能", category: "hard", weight: 5, reason: "该职业最直接决定产出质量的能力" },
  { name: "工具与工作流", category: "hard", weight: 4, reason: "熟练度直接换算成每天省下的时间" },
  { name: "职业英语", category: "language", weight: 3, reason: "扩大可获取的一手信息范围" },
  { name: "结构化表达", category: "soft", weight: 4, reason: "让判断和方案能被他人理解与采纳" },
  { name: "反馈与复盘", category: "soft", weight: 3, reason: "把一次性经验变成可复用的能力" },
];

const SkillPlan = z.object({
  skills: z
    .array(
      z.object({
        name: z.string(),
        category: z.enum(["hard", "soft", "language"]),
        reason: z.string(),
        weight: z.number().int().min(1).max(5),
      }),
    )
    .min(3)
    .max(8),
});

const PlanDraft = z.object({
  goal: z.string(),
  milestones: z
    .array(z.object({ label: z.string(), focus: z.string() }))
    .min(2)
    .max(6),
  activities: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        type: z.enum(["reading", "practice", "quiz", "review"]),
        estMinutes: z.number().int().positive(),
      }),
    )
    .min(2)
    .max(6),
});

export class LearningService {
  constructor(
    private readonly db: Db,
    private readonly models: ModelResolver,
  ) {}

  // ---------- 画像 ----------

  listProfiles(): LearningProfile[] {
    return this.db
      .select()
      .from(learningProfiles)
      .orderBy(desc(learningProfiles.createdAt))
      .all()
      .map((r) => ({
        id: r.id,
        profession: r.profession,
        targetRole: r.targetRole,
        dailyBudgetMin: r.dailyBudgetMin,
        createdAt: r.createdAt,
      }));
  }

  createProfile(input: LearningProfileInput): LearningProfile {
    const profile: LearningProfile = {
      id: newId(),
      profession: input.profession.trim(),
      targetRole: input.targetRole?.trim() || null,
      dailyBudgetMin: input.dailyBudgetMin,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(learningProfiles).values(profile).run();
    return profile;
  }

  // ---------- 技能建议 ----------

  /**
   * 让模型根据职业给出硬实力/软实力建议。
   * 没有可用模型时退回内置模板，并把 origin 标成 builtin——界面据此说明这不是针对性分析。
   */
  async suggestSkills(
    profession: string,
    targetRole?: string | null,
    signal?: AbortSignal,
  ): Promise<SkillSuggestionResult> {
    const trimmed = profession.trim();
    const fallback = (): SkillSuggestionResult => ({
      profession: trimmed,
      origin: "builtin",
      skills: BUILTIN_SKILLS[trimmed] ?? GENERIC_SKILLS,
    });

    try {
      const models = await this.models.resolve("orchestrator");
      if (models.length === 0) return fallback();
      const parsed = await completeStructured({
        models,
        schema: SkillPlan,
        maxTokens: 900,
        signal,
        systemPrompt: `你帮一位从业者梳理他所在职业需要掌握的能力。
给出 5 条左右的能力建议，覆盖硬实力(hard)、软实力(soft)和语言能力(language)。
category 只能是 hard、soft、language 之一；weight 是该能力对这个职业的重要度，1 到 5 的整数。
reason 用一句中文说明为什么这条能力对这个职业重要，不超过 40 字，要具体，不要套话。
这些是面向该职业的通用建议，不是对某个人的能力测评。`,
        prompt: targetRole ? `职业：${trimmed}\n目标岗位：${targetRole}` : `职业：${trimmed}`,
      });
      return { profession: trimmed, origin: "model", skills: parsed.skills };
    } catch {
      return fallback();
    }
  }

  // ---------- 计划 ----------

  listPlans(profileId?: string): LearningPlan[] {
    const rows = this.db
      .select()
      .from(learningPlans)
      .where(profileId ? eq(learningPlans.profileId, profileId) : undefined)
      .orderBy(desc(learningPlans.createdAt))
      .all();
    return this.hydratePlans(rows);
  }

  getPlan(id: string): LearningPlan | undefined {
    const row = this.db.select().from(learningPlans).where(eq(learningPlans.id, id)).get();
    return row ? this.hydratePlans([row])[0] : undefined;
  }

  private hydratePlans(rows: Array<typeof learningPlans.$inferSelect>): LearningPlan[] {
    if (rows.length === 0) return [];
    const versions = this.db
      .select()
      .from(learningPlanVersions)
      .where(
        inArray(
          learningPlanVersions.id,
          rows.map((r) => r.currentVersionId),
        ),
      )
      .all();
    const byId = new Map(versions.map((v) => [v.id, v]));
    return rows.flatMap((r) => {
      const v = byId.get(r.currentVersionId);
      if (!v) return [];
      return [
        {
          id: r.id,
          profileId: r.profileId,
          skillName: r.skillName,
          status: r.status,
          goal: v.goal,
          milestones: v.milestones,
          durationDays: v.durationDays,
          currentVersionId: r.currentVersionId,
          createdAt: r.createdAt,
        },
      ];
    });
  }

  /** 生成一份计划：模型产出目标、里程碑和第一天的活动；无模型时用内置结构兜底。 */
  async createPlan(input: LearningPlanInput, signal?: AbortSignal): Promise<LearningPlan> {
    const profile = this.db
      .select()
      .from(learningProfiles)
      .where(eq(learningProfiles.id, input.profileId))
      .get();
    if (!profile) throw new Error("画像不存在");

    const draft = await this.draftPlan(
      profile.profession,
      input.skillName,
      input.durationDays,
      profile.dailyBudgetMin,
      signal,
    );

    const now = new Date().toISOString();
    const planId = newId();
    const versionId = newId();

    this.db.transaction((tx) => {
      tx.insert(learningPlanVersions)
        .values({
          id: versionId,
          planId,
          goal: draft.goal,
          milestones: draft.milestones,
          durationDays: input.durationDays,
          changeReason: null,
          createdAt: now,
        })
        .run();
      tx.insert(learningPlans)
        .values({
          id: planId,
          profileId: input.profileId,
          skillName: input.skillName,
          status: "active",
          currentVersionId: versionId,
          createdAt: now,
        })
        .run();
      const today = localDate();
      tx.insert(learningActivities)
        .values(
          draft.activities.map((a, i) => ({
            id: newId(),
            planId,
            planVersionId: versionId,
            date: today,
            orderIndex: i,
            title: a.title,
            detail: a.detail,
            type: a.type,
            estMinutes: a.estMinutes,
            status: "pending" as const,
            completedAt: null,
          })),
        )
        .run();
    });

    const plan = this.getPlan(planId);
    if (!plan) throw new Error("计划创建失败");
    return plan;
  }

  private async draftPlan(
    profession: string,
    skillName: string,
    durationDays: number,
    budgetMin: number,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof PlanDraft>> {
    const fallback = (): z.infer<typeof PlanDraft> => ({
      goal: `用 ${durationDays} 天把「${skillName}」练到能在日常工作中稳定用出来。`,
      milestones: defaultMilestones(durationDays),
      activities: defaultActivities(skillName, budgetMin),
    });
    try {
      const models = await this.models.resolve("orchestrator");
      if (models.length === 0) return fallback();
      return await completeStructured({
        models,
        schema: PlanDraft,
        maxTokens: 1200,
        signal,
        systemPrompt: `你为一位从业者制定一份可执行的技能提升计划。
goal：一句话说明 ${durationDays} 天后他应该能做到什么，要具体到可以被检验，不要写"熟练掌握"这种无法判断的说法。
milestones：把 ${durationDays} 天分成 4 个阶段，label 是时间范围（如"第 1 周"），focus 是这个阶段的重点，不超过 12 字。
activities：今天就能开始做的 3 到 4 件事，总时长控制在 ${budgetMin} 分钟左右。
每件事的 title 是动词开头的具体动作，detail 用一句话说明怎么做和做到什么程度。
type 只能是 reading、practice、quiz、review 之一。至少要有一件 practice。
不要安排"看视频""找资料"这种无法验证完成质量的任务。`,
        prompt: `职业：${profession}\n要提升的能力：${skillName}\n每天可投入：${budgetMin} 分钟\n计划长度：${durationDays} 天`,
      });
    } catch {
      return fallback();
    }
  }

  // ---------- 今日学习 ----------

  today(date = localDate()): LearningToday {
    const profile = this.listProfiles()[0] ?? null;
    const plan =
      this.listPlans(profile?.id).find((p) => p.status === "active") ??
      this.listPlans(profile?.id)[0] ??
      null;

    if (plan && plan.status === "active") this.ensureDay(plan, date);

    const activities = plan
      ? this.db
          .select()
          .from(learningActivities)
          .where(and(eq(learningActivities.planId, plan.id), eq(learningActivities.date, date)))
          .orderBy(learningActivities.orderIndex)
          .all()
          .map(toActivity)
      : [];

    const yDate = shiftDate(date, -1);
    const yRows = plan
      ? this.db
          .select()
          .from(learningActivities)
          .where(and(eq(learningActivities.planId, plan.id), eq(learningActivities.date, yDate)))
          .orderBy(learningActivities.orderIndex)
          .all()
      : [];
    const yDone = yRows.filter((r) => r.status === "done");

    const checkins = this.db
      .select()
      .from(learningCheckins)
      .where(gte(learningCheckins.date, shiftDate(date, -125)))
      .orderBy(learningCheckins.date)
      .all()
      .map((r) => ({
        date: r.date,
        effectiveMinutes: r.effectiveMinutes,
        activitiesDone: r.activitiesDone,
      }));

    return {
      date,
      profile,
      plan,
      activities,
      yesterday: {
        date: yDate,
        done: yDone.length,
        total: yRows.length,
        minutes: yDone.reduce((s, r) => s + r.estMinutes, 0),
        titles: yDone.map((r) => r.title),
      },
      streak: computeStreak(checkins, date),
      checkins,
      dueReviews: Number(
        this.db.select({ n: count() }).from(reviewItems).where(lte(reviewItems.dueDate, date)).get()
          ?.n ?? 0,
      ),
    };
  }

  /**
   * 计划处于 active 且当天还没有活动时，按里程碑阶段生成当天任务。
   * 这一步不调用模型，保证离线和断网时每天照样能开始学。
   */
  private ensureDay(plan: LearningPlan, date: string): void {
    const existing = this.db
      .select({ id: learningActivities.id })
      .from(learningActivities)
      .where(and(eq(learningActivities.planId, plan.id), eq(learningActivities.date, date)))
      .all();
    if (existing.length > 0) return;

    const dayIndex = daysBetween(plan.createdAt.slice(0, 10), date);
    if (dayIndex < 0 || dayIndex >= plan.durationDays) return;

    const budget =
      this.db.select().from(learningProfiles).where(eq(learningProfiles.id, plan.profileId)).get()
        ?.dailyBudgetMin ?? 30;
    const stage =
      plan.milestones[
        Math.min(
          plan.milestones.length - 1,
          Math.floor((dayIndex / plan.durationDays) * plan.milestones.length),
        )
      ];

    const activities = dailyActivities(plan.skillName, stage?.focus ?? plan.skillName, budget);
    this.db
      .insert(learningActivities)
      .values(
        activities.map((a, i) => ({
          id: newId(),
          planId: plan.id,
          planVersionId: plan.currentVersionId,
          date,
          orderIndex: i,
          title: a.title,
          detail: a.detail,
          type: a.type,
          estMinutes: a.estMinutes,
          status: "pending" as const,
          completedAt: null,
        })),
      )
      .run();
  }

  /** 标记一件活动完成，并把当天打卡重算一次（打卡由活动派生，不单独写入）。 */
  setActivityStatus(id: string, status: "pending" | "done" | "skipped"): LearningActivity {
    const row = this.db
      .select()
      .from(learningActivities)
      .where(eq(learningActivities.id, id))
      .get();
    if (!row) throw new Error("活动不存在");

    this.db
      .update(learningActivities)
      .set({ status, completedAt: status === "done" ? new Date().toISOString() : null })
      .where(eq(learningActivities.id, id))
      .run();

    this.recomputeCheckin(row.date);

    const updated = this.db
      .select()
      .from(learningActivities)
      .where(eq(learningActivities.id, id))
      .get();
    return toActivity(updated!);
  }

  private recomputeCheckin(date: string): void {
    const rows = this.db
      .select()
      .from(learningActivities)
      .where(and(eq(learningActivities.date, date), eq(learningActivities.status, "done")))
      .all();
    const minutes = rows.reduce((s, r) => s + r.estMinutes, 0);
    const now = new Date().toISOString();
    if (rows.length === 0) {
      this.db.delete(learningCheckins).where(eq(learningCheckins.date, date)).run();
      return;
    }
    this.db
      .insert(learningCheckins)
      .values({ date, effectiveMinutes: minutes, activitiesDone: rows.length, updatedAt: now })
      .onConflictDoUpdate({
        target: learningCheckins.date,
        set: { effectiveMinutes: minutes, activitiesDone: rows.length, updatedAt: now },
      })
      .run();
  }
}

function toActivity(r: typeof learningActivities.$inferSelect): LearningActivity {
  return {
    id: r.id,
    planId: r.planId,
    planVersionId: r.planVersionId,
    date: r.date,
    orderIndex: r.orderIndex,
    title: r.title,
    detail: r.detail,
    type: r.type,
    estMinutes: r.estMinutes,
    status: r.status,
    completedAt: r.completedAt,
  };
}

/** 连续有效学习日：从今天（或昨天，今天还没学不算中断）往前数。 */
function computeStreak(checkins: Checkin[], today: string): number {
  const days = new Set(checkins.filter((c) => c.activitiesDone > 0).map((c) => c.date));
  let cursor = days.has(today) ? today : shiftDate(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor = shiftDate(cursor, -1);
  }
  return streak;
}

function defaultMilestones(durationDays: number): Milestone[] {
  const span = Math.max(1, Math.round(durationDays / 4));
  return [
    { label: `第 1–${span} 天`, focus: "建立基础认知" },
    { label: `第 ${span + 1}–${span * 2} 天`, focus: "拆解并模仿" },
    { label: `第 ${span * 2 + 1}–${span * 3} 天`, focus: "独立完成" },
    { label: `第 ${span * 3 + 1}–${durationDays} 天`, focus: "迁移与复测" },
  ];
}

type DraftActivity = { title: string; detail: string; type: ActivityType; estMinutes: number };

function split(budget: number, parts: number[]): number[] {
  const total = parts.reduce((a, b) => a + b, 0);
  return parts.map((p) => Math.max(3, Math.round((budget * p) / total)));
}

function defaultActivities(skillName: string, budget: number): DraftActivity[] {
  const m = split(budget, [1, 2, 2]);
  return [
    {
      title: "先回忆，再看答案",
      detail: `不看任何材料，先说出你现在对「${skillName}」已经确定知道的部分。`,
      type: "review",
      estMinutes: m[0]!,
    },
    {
      title: "带着问题读一段材料",
      detail: "只读能回答你刚才卡住的那个问题的部分，读完用自己的话复述一遍。",
      type: "reading",
      estMinutes: m[1]!,
    },
    {
      title: "独立做一次完整练习",
      detail: "不看参考答案完成一遍，卡住的地方记下来，明天用新题验证。",
      type: "practice",
      estMinutes: m[2]!,
    },
  ];
}

function dailyActivities(skillName: string, focus: string, budget: number): DraftActivity[] {
  const m = split(budget, [1, 2, 2, 1]);
  return [
    {
      title: "回忆昨天的内容",
      detail: "不看笔记，先说出昨天练过的要点，想不起来的标记出来。",
      type: "review",
      estMinutes: m[0]!,
    },
    {
      title: `读一段关于「${focus}」的材料`,
      detail: "带着昨天没想起来的问题去读，读完用自己的话复述。",
      type: "reading",
      estMinutes: m[1]!,
    },
    {
      title: `独立练习：${focus}`,
      detail: `围绕「${skillName}」完成一次不看答案的练习，记录卡住的地方。`,
      type: "practice",
      estMinutes: m[2]!,
    },
    {
      title: "总结错误，安排明天验证",
      detail: "把今天出错的点写成一句话，明天用一道新题独立验证。",
      type: "quiz",
      estMinutes: m[3]!,
    },
  ];
}
