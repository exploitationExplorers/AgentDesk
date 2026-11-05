import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Flame, GraduationCap, Layers, PartyPopper, Undo2, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LearningActivity, LearningToday } from "@agentdesk/shared";
import {
  AnimatePresence,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  RouteFlow,
  Spinner,
  cn,
  gridItemVariants,
  motion,
  popVariants,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { LearningNav } from "./LearningNav";
import { PLUGINS, TODAY_STEPS } from "./pipeline";

const TYPE_LABEL: Record<LearningActivity["type"], string> = {
  reading: "阅读",
  practice: "练习",
  quiz: "测验",
  review: "复习",
};

/** 数字滚动。用 rAF 做，避免为一个计数器引入额外的动画依赖。 */
function useCountUp(target: number, duration = 650) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setValue(Math.round(from + (target - from) * e));
      if (k < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

export function LearningPage() {
  const queryClient = useQueryClient();
  const today = useQuery({ queryKey: ["learning-today"], queryFn: () => api.learningToday() });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "pending" | "done" }) =>
      api.setActivityStatus(id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["learning-today"] }),
  });

  if (today.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const data = today.data;
  if (!data?.plan || !data.profile) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">
          <PageHeader
            title="成长中心"
            description="选一个职业，让它帮你把「想变强」变成每天能做完的事"
            icon={<GraduationCap className="h-5 w-5" />}
            actions={<LearningNav />}
          />
          <EmptyState
            icon={<GraduationCap className="h-8 w-8" />}
            title="还没有学习计划"
            description="先告诉它你的职业，它会分析这个职业需要的硬实力和软实力，再把你选中的那一项拆成可执行的每日任务。"
            action={
              <Link to="/learning/career">
                <Button variant="brand">开始</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const done = data.activities.filter((a) => a.status === "done").length;
  const total = data.activities.length;
  const totalMin = data.activities.reduce((s, a) => s + a.estMinutes, 0);
  const allDone = total > 0 && done === total;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          title={data.plan.skillName}
          description={data.plan.goal}
          icon={<GraduationCap className="h-5 w-5" />}
          actions={<LearningNav dueCount={data.dueReviews} />}
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0 space-y-4">
            <Yesterday yesterday={data.yesterday} />

            <Card className="p-5">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <h2 className="text-[15px] font-semibold tracking-tight">今天的任务</h2>
                <span className="text-[12px] tabular-nums text-subtle">
                  {done}/{total} 完成 · 共 {totalMin} 分钟
                </span>
              </div>

              <div className="mb-4 h-1 overflow-hidden rounded-full bg-surface-2">
                <motion.div
                  className="h-full rounded-full bg-brand"
                  initial={false}
                  animate={{ width: `${total ? (done / total) * 100 : 0}%` }}
                  transition={{ type: "spring", stiffness: 220, damping: 30 }}
                />
              </div>

              <AnimatePresence>
                {allDone ? (
                  <motion.div
                    variants={popVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="mb-3 flex items-center gap-2.5 rounded-xl border border-success/30 bg-success/10 px-3.5 py-3 text-[13px] text-success"
                  >
                    <PartyPopper className="h-4 w-4 shrink-0" />
                    今天的任务全部完成了。明天的内容会在你打开时准备好。
                  </motion.div>
                ) : null}
              </AnimatePresence>

              <ol className="grid gap-1.5">
                {data.activities.map((a, i) => {
                  const isDone = a.status === "done";
                  return (
                    <motion.li
                      key={a.id}
                      layout
                      variants={gridItemVariants}
                      initial="hidden"
                      animate="visible"
                      transition={{ delay: i * 0.05 }}
                      className={cn(
                        "grid grid-cols-[26px_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl border px-3.5 py-3",
                        isDone ? "border-success/25 bg-success/5" : "bg-surface",
                      )}
                    >
                      <span className="font-mono text-[11px] text-subtle">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <motion.p
                          animate={{ opacity: isDone ? 0.55 : 1 }}
                          className={cn(
                            "truncate text-[13.5px] font-medium",
                            isDone && "line-through",
                          )}
                        >
                          {a.title}
                        </motion.p>
                        <motion.p
                          animate={{ opacity: isDone ? 0.4 : 1 }}
                          className="mt-0.5 text-[12px] text-subtle"
                        >
                          {a.detail}
                        </motion.p>
                      </div>
                      <Badge tone={isDone ? "success" : "neutral"}>{TYPE_LABEL[a.type]}</Badge>
                      <div className="flex items-center gap-2">
                        <span className="whitespace-nowrap text-[12px] tabular-nums text-subtle">
                          {a.estMinutes} 分钟
                        </span>
                        <motion.div whileTap={{ scale: 0.86 }}>
                          <Button
                            size="icon"
                            variant={isDone ? "brand" : "secondary"}
                            aria-label={isDone ? "标记为未完成" : "标记为完成"}
                            disabled={setStatus.isPending}
                            onClick={() =>
                              setStatus.mutate({ id: a.id, status: isDone ? "pending" : "done" })
                            }
                          >
                            <AnimatePresence mode="wait" initial={false}>
                              <motion.span
                                key={isDone ? "done" : "todo"}
                                variants={popVariants}
                                initial="initial"
                                animate="animate"
                                exit="exit"
                              >
                                {isDone ? (
                                  <Undo2 className="h-3.5 w-3.5" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                              </motion.span>
                            </AnimatePresence>
                          </Button>
                        </motion.div>
                      </div>
                    </motion.li>
                  );
                })}
              </ol>
            </Card>

            <div>
              <div className="mb-2 flex items-baseline gap-3">
                <h2 className="text-[15px] font-semibold tracking-tight">这些任务是怎么来的</h2>
                <span className="text-[12px] text-subtle">
                  Supervisor 路由到能力插件，产出先经业务层校验再落库
                </span>
              </div>
              <RouteFlow
                source={{
                  label: "你",
                  sub: `今天 ${data.profile.dailyBudgetMin} 分钟`,
                  icon: <User className="h-6 w-6" />,
                }}
                hub={{
                  label: "Supervisor",
                  sub: "学习域路由",
                  icon: <Layers className="h-6 w-6" />,
                }}
                targets={PLUGINS}
                steps={TODAY_STEPS}
              />
            </div>
          </div>

          <aside className="min-w-0 space-y-4">
            <StreakCard streak={data.streak} checkins={data.checkins} today={data.date} />
            <Card className="p-5">
              <h3 className="mb-3 text-[13.5px] font-semibold">里程碑</h3>
              <ul className="grid gap-1.5">
                {data.plan.milestones.map((m, i) => (
                  <motion.li
                    key={m.label}
                    variants={gridItemVariants}
                    initial="hidden"
                    animate="visible"
                    transition={{ delay: 0.1 + i * 0.05 }}
                    className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]"
                  >
                    <span className="shrink-0">{m.label}</span>
                    <span className="truncate text-right text-[11px] text-subtle">{m.focus}</span>
                  </motion.li>
                ))}
              </ul>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Yesterday({ yesterday }: { yesterday: LearningToday["yesterday"] }) {
  if (yesterday.total === 0) return null;
  return (
    <motion.div variants={gridItemVariants} initial="hidden" animate="visible">
      <Card className="p-4">
        <p className="text-[11.5px] font-medium text-subtle">昨天（{yesterday.date}）</p>
        {yesterday.done === 0 ? (
          <p className="mt-1 text-[13px] text-muted">昨天没有完成的任务。今天从第一件开始就行。</p>
        ) : (
          <p className="mt-1 text-[13px] text-muted">
            完成 {yesterday.done}/{yesterday.total} 件，约 {yesterday.minutes} 分钟：
            {yesterday.titles.join("、")}。
          </p>
        )}
      </Card>
    </motion.div>
  );
}

/** 连续学习天数与最近 18 周热力图。只有当天真的完成过任务才算一天。 */
function StreakCard({
  streak,
  checkins,
  today,
}: {
  streak: number;
  checkins: LearningToday["checkins"];
  today: string;
}) {
  const shown = useCountUp(streak);
  const byDate = new Map(checkins.map((c) => [c.date, c.activitiesDone]));
  const cells: Array<{ date: string; level: number }> = [];
  const [y, m, d] = today.split("-").map(Number);
  const cursor = new Date(y!, m! - 1, d!);
  cursor.setDate(cursor.getDate() - 125);
  for (let i = 0; i < 126; i++) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
    const n = byDate.get(key) ?? 0;
    cells.push({ date: key, level: n === 0 ? 0 : n <= 1 ? 1 : n <= 3 ? 2 : 3 });
    cursor.setDate(cursor.getDate() + 1);
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <motion.div
          animate={streak > 0 ? { scale: [1, 1.12, 1], rotate: [-2, 2, -2] } : {}}
          transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
        >
          <Flame className={cn("h-7 w-7", streak > 0 ? "text-warning" : "text-subtle")} />
        </motion.div>
        <div>
          <p className="text-[26px] font-semibold leading-none tabular-nums">{shown}</p>
          <p className="mt-1 text-[11.5px] text-subtle">连续有效学习日</p>
        </div>
      </div>
      <div
        className="mt-4 grid grid-flow-col justify-start gap-[3px]"
        style={{ gridTemplateRows: "repeat(7, 9px)" }}
      >
        {cells.map((c, i) => (
          <motion.span
            key={c.date}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: Math.min(0.6, i * 0.003), duration: 0.18 }}
            title={`${c.date}：完成 ${byDate.get(c.date) ?? 0} 件`}
            className="h-[9px] w-[9px] rounded-[2px]"
            style={{
              background:
                c.level === 0
                  ? "var(--ad-surface-2)"
                  : `color-mix(in srgb, var(--ad-brand) ${c.level * 30 + 10}%, var(--ad-surface))`,
            }}
          />
        ))}
      </div>
    </Card>
  );
}
