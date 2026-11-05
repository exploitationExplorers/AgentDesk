import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Layers, Sparkles, User } from "lucide-react";
import { useState } from "react";
import type { SkillSuggestion } from "@agentdesk/shared";
import {
  AnimatePresence,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  RouteFlow,
  Segmented,
  Spinner,
  cn,
  gridItemVariants,
  motion,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { LearningNav } from "./LearningNav";
import { CAREER_STEPS, PLUGINS } from "./pipeline";

const CATEGORY: Record<
  SkillSuggestion["category"],
  { label: string; tone: "brand" | "info" | "success" }
> = {
  hard: { label: "硬实力", tone: "brand" },
  soft: { label: "软实力", tone: "info" },
  language: { label: "语言能力", tone: "success" },
};

const PRESETS = ["前端工程师", "产品经理", "数据分析师"];

export function CareerMapPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [profession, setProfession] = useState("前端工程师");
  const [targetRole, setTargetRole] = useState("");
  const [budget, setBudget] = useState<15 | 30 | 45>(30);
  const [picked, setPicked] = useState<string | null>(null);

  const existing = useQuery({ queryKey: ["learning-profiles"], queryFn: api.learningProfiles });

  const suggest = useMutation({
    mutationFn: () => api.suggestSkills(profession.trim(), targetRole.trim() || null),
    onSuccess: () => setPicked(null),
  });

  const create = useMutation({
    mutationFn: async (skillName: string) => {
      const profile =
        existing.data?.find((p) => p.profession === profession.trim()) ??
        (await api.createLearningProfile({
          profession: profession.trim(),
          targetRole: targetRole.trim() || null,
          dailyBudgetMin: budget,
        }));
      return api.createLearningPlan({ profileId: profile.id, skillName, durationDays: 28 });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["learning-today"] });
      await queryClient.invalidateQueries({ queryKey: ["learning-profiles"] });
      void navigate({ to: "/learning" });
    },
  });

  const result = suggest.data;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-8 py-8">
        <PageHeader
          title="职业能力地图"
          description="先确定职业，再挑一项要提升的能力——计划会按这项能力生成"
          icon={<Sparkles className="h-5 w-5" />}
          actions={<LearningNav />}
        />

        <Card className="p-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Field label="职业">
              <Input
                value={profession}
                onChange={(e) => setProfession(e.target.value)}
                placeholder="例如：前端工程师"
              />
            </Field>
            <Field label="目标岗位（可选）" hint="填了的话，建议会更贴近这个方向">
              <Input
                value={targetRole}
                onChange={(e) => setTargetRole(e.target.value)}
                placeholder="例如：高级前端 / 前端架构"
              />
            </Field>
            <Field label="每天可投入">
              <Segmented
                value={String(budget)}
                onChange={(v) => setBudget(Number(v) as 15 | 30 | 45)}
                options={[
                  { value: "15", label: "15 分钟" },
                  { value: "30", label: "30 分钟" },
                  { value: "45", label: "45 分钟" },
                ]}
              />
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProfession(p)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-[12px] transition-colors",
                  profession === p
                    ? "border-brand bg-brand/10 text-brand"
                    : "text-muted hover:text-fg",
                )}
              >
                {p}
              </button>
            ))}
            <div className="ml-auto">
              <Button
                variant="brand"
                disabled={!profession.trim() || suggest.isPending}
                onClick={() => suggest.mutate()}
              >
                {suggest.isPending ? <Spinner className="text-white" /> : null}
                分析这个职业需要什么能力
              </Button>
            </div>
          </div>
        </Card>

        <AnimatePresence>
          {suggest.isPending ? (
            <motion.div
              key="skeleton"
              variants={gridItemVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
            >
              {[0, 1, 2, 3, 4].map((i) => (
                <motion.div
                  key={i}
                  animate={{ opacity: [0.35, 0.75, 0.35] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "linear", delay: i * 0.12 }}
                  className="h-[108px] rounded-2xl border bg-surface-2"
                />
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {suggest.isError ? (
          <Card className="border-danger/40 p-4 text-[13px] text-danger">
            分析失败了。可以再试一次，或者直接换一个职业名称。
          </Card>
        ) : null}

        {result ? (
          <>
            <div className="flex items-baseline gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight">
                {result.profession} · 能力建议
              </h2>
              <span className="text-[12px] text-subtle">
                {result.origin === "model"
                  ? "由模型分析得出。这是面向该职业的通用建议，不是对你的能力测评。"
                  : "当前没有可用模型，这是内置的通用职业模板，不是针对你的分析。"}
              </span>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {result.skills.map((s, i) => {
                const on = picked === s.name;
                return (
                  <motion.button
                    key={s.name}
                    type="button"
                    layout
                    variants={gridItemVariants}
                    initial="hidden"
                    animate="visible"
                    transition={{ delay: i * 0.06 }}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.985 }}
                    onClick={() => setPicked(s.name)}
                    className={cn(
                      "rounded-2xl border bg-surface p-4 text-left transition-colors",
                      on
                        ? "border-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--ad-brand)_14%,transparent)]"
                        : "hover:border-border-strong",
                    )}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <Badge tone={CATEGORY[s.category].tone}>{CATEGORY[s.category].label}</Badge>
                      <span className="font-mono text-[11px] text-subtle">
                        {"●".repeat(s.weight)}
                        <span className="opacity-30">{"●".repeat(5 - s.weight)}</span>
                      </span>
                    </div>
                    <p className="text-[14px] font-medium">{s.name}</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted">{s.reason}</p>
                  </motion.button>
                );
              })}
            </div>

            <div className="flex items-center justify-end gap-3">
              {picked ? (
                <span className="text-[12.5px] text-muted">将为「{picked}」生成一份 28 天计划</span>
              ) : (
                <span className="text-[12.5px] text-subtle">选一项你想先提升的能力</span>
              )}
              <Button
                variant="brand"
                disabled={!picked || create.isPending}
                onClick={() => picked && create.mutate(picked)}
              >
                {create.isPending ? <Spinner className="text-white" /> : null}
                生成学习计划
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>

            {create.isError ? (
              <Card className="border-danger/40 p-4 text-[13px] text-danger">
                计划生成失败了，请再试一次。已有的画像不会重复创建。
              </Card>
            ) : null}
          </>
        ) : null}

        <div>
          <div className="mb-2 flex items-baseline gap-3">
            <h2 className="text-[15px] font-semibold tracking-tight">这一步背后发生了什么</h2>
            <span className="text-[12px] text-subtle">点上面的按钮时，走的就是这条链路</span>
          </div>
          <RouteFlow
            source={{
              label: "你",
              sub: profession || "选择职业",
              icon: <User className="h-6 w-6" />,
            }}
            hub={{ label: "Supervisor", sub: "学习域路由", icon: <Layers className="h-6 w-6" /> }}
            targets={PLUGINS}
            steps={CAREER_STEPS}
          />
        </div>
      </div>
    </div>
  );
}
