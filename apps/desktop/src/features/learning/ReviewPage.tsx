import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Brain, Check, Quote, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { GradeResult, ReviewRating } from "@agentdesk/shared";
import {
  AnimatePresence,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  cn,
  motion,
  panelVariants,
  popVariants,
} from "@agentdesk/ui";
import { api } from "../../lib/api";
import { LearningNav } from "./LearningNav";

const RATINGS: Array<{ value: ReviewRating; label: string; hint: string; cls: string }> = [
  { value: 1, label: "忘记", hint: "完全想不起来", cls: "hover:border-danger hover:text-danger" },
  {
    value: 2,
    label: "困难",
    hint: "想起来了但很吃力",
    cls: "hover:border-warning hover:text-warning",
  },
  { value: 3, label: "一般", hint: "正常回忆出来", cls: "hover:border-brand hover:text-brand" },
  { value: 4, label: "容易", hint: "毫不费力", cls: "hover:border-success hover:text-success" },
];

export function ReviewPage() {
  const queryClient = useQueryClient();
  const queue = useQuery({ queryKey: ["review-queue"], queryFn: () => api.reviewQueue() });
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [lastResult, setLastResult] = useState<GradeResult | null>(null);
  const [graded, setGraded] = useState(0);

  const cards = queue.data?.cards ?? [];
  const card = cards[index];

  const grade = useMutation({
    mutationFn: ({ id, rating }: { id: string; rating: ReviewRating }) =>
      api.gradeReview(id, rating),
    onSuccess: (result) => {
      setLastResult(result);
      setGraded((n) => n + 1);
      setRevealed(false);
      setIndex((i) => i + 1);
      void queryClient.invalidateQueries({ queryKey: ["learning-today"] });
    },
  });

  // 空格翻卡，1–4 评分。复习是高频重复动作，键盘比鼠标快得多。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card || grade.isPending) return;
      if (e.code === "Space") {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      if (!revealed) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 4) grade.mutate({ id: card.itemId, rating: n as ReviewRating });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, revealed, grade]);

  if (queue.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const finished = !card;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-8 py-8">
        <PageHeader
          title="今日复习"
          description="按 FSRS 排出的队列：先巩固快忘掉的，再看新内容"
          icon={<Brain className="h-5 w-5" />}
          actions={<LearningNav dueCount={queue.data?.dueCount} />}
        />

        {queue.data ? (
          <div className="flex items-center gap-4 text-[12.5px] text-subtle">
            <span>
              共 <b className="tabular-nums text-fg">{queue.data.totalUnits}</b> 个知识点
            </span>
            <span>
              今日到期 <b className="tabular-nums text-fg">{queue.data.dueCount}</b>
            </span>
            <span>
              其中新内容 <b className="tabular-nums text-fg">{queue.data.newCount}</b>
            </span>
            <div className="ml-auto flex-1 overflow-hidden">
              <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
                <motion.div
                  className="h-full rounded-full bg-brand"
                  initial={false}
                  animate={{ width: `${cards.length ? (graded / cards.length) * 100 : 100}%` }}
                  transition={{ type: "spring", stiffness: 220, damping: 30 }}
                />
              </div>
            </div>
          </div>
        ) : null}

        <AnimatePresence mode="wait">
          {finished ? (
            <motion.div
              key="done"
              variants={popVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {queue.data?.totalUnits === 0 ? (
                <EmptyState
                  icon={<Sparkles className="h-8 w-8" />}
                  title="还没有可复习的知识点"
                  description="先去资料库导入一份资料，它会自动拆成知识点并排进复习队列。"
                  action={
                    <Link to="/learning/library">
                      <Button variant="brand">去导入资料</Button>
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  icon={<Check className="h-8 w-8 text-success" />}
                  title={graded > 0 ? `复习完了，这轮过了 ${graded} 条` : "今天没有到期的内容"}
                  description="下次到期时间已经按你这次的评分重新算过。提前刷不会让记忆更牢，明天再来就好。"
                />
              )}
            </motion.div>
          ) : (
            <motion.div
              key={card.itemId}
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <Badge tone={card.reps === 0 ? "info" : card.overdue ? "warning" : "neutral"}>
                    {card.reps === 0 ? "新内容" : card.overdue ? "已逾期" : "到期"}
                  </Badge>
                  <span className="truncate text-[12px] text-subtle">{card.sourceTitle}</span>
                  <span className="ml-auto whitespace-nowrap text-[11.5px] tabular-nums text-subtle">
                    {index + 1} / {cards.length}
                    {card.stability != null
                      ? ` · S ${card.stability.toFixed(1)}天 · D ${card.difficulty?.toFixed(1)}`
                      : ""}
                    {card.retrievability != null
                      ? ` · R ${(card.retrievability * 100).toFixed(0)}%`
                      : ""}
                  </span>
                </div>

                <p className="text-[12px] font-medium text-subtle">{card.unit.title}</p>
                <p className="mt-2 text-[17px] font-medium leading-relaxed">{card.unit.question}</p>

                <AnimatePresence initial={false} mode="wait">
                  {revealed ? (
                    <motion.div
                      key="answer"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-5 rounded-xl border-l-2 border-brand bg-surface-2 px-4 py-3">
                        <p className="text-[14px] leading-relaxed">{card.unit.answer}</p>
                      </div>
                      <p className="mt-3 text-[13px] leading-relaxed text-muted">
                        {card.unit.summary}
                      </p>
                      <details className="group mt-3">
                        <summary className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-subtle hover:text-fg">
                          <Quote className="h-3 w-3" />
                          看原文出处
                        </summary>
                        <p className="mt-2 whitespace-pre-wrap rounded-lg border-l-2 border-border-strong bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-muted">
                          {card.unit.sourceText || "（原文块已不存在）"}
                        </p>
                      </details>
                    </motion.div>
                  ) : null}
                </AnimatePresence>

                <div className="mt-6">
                  {!revealed ? (
                    <Button variant="brand" className="w-full" onClick={() => setRevealed(true)}>
                      显示答案<span className="ml-1 opacity-60">空格</span>
                    </Button>
                  ) : (
                    <div className="grid grid-cols-4 gap-2">
                      {RATINGS.map((r) => (
                        <motion.button
                          key={r.value}
                          type="button"
                          whileHover={{ y: -2 }}
                          whileTap={{ scale: 0.96 }}
                          disabled={grade.isPending}
                          onClick={() => grade.mutate({ id: card.itemId, rating: r.value })}
                          className={cn(
                            "rounded-xl border bg-surface px-2 py-3 text-center transition-colors disabled:opacity-50",
                            r.cls,
                          )}
                        >
                          <span className="block text-[13.5px] font-medium">{r.label}</span>
                          <span className="mt-0.5 block text-[10.5px] text-subtle">{r.hint}</span>
                          <span className="mt-1 block font-mono text-[10px] text-subtle">
                            {r.value}
                          </span>
                        </motion.button>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {lastResult ? (
            <motion.p
              key={lastResult.itemId + lastResult.dueDate}
              variants={popVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              className="text-center text-[12.5px] text-subtle"
            >
              上一条已安排在 <b className="tabular-nums text-fg">{lastResult.intervalDays}</b> 天后
              （{lastResult.dueDate}）再出现，稳定性更新为{" "}
              <b className="tabular-nums text-fg">{lastResult.stability.toFixed(1)}</b> 天。
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
