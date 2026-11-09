import type {
  InterviewQuestion,
  InterviewReviewInput,
  InterviewSource,
  InterviewStats,
} from "@agentdesk/shared";
import {
  AnimatePresence,
  Badge,
  Button,
  Dialog,
  EmptyState,
  GlassFolder,
  GlassSurface,
  GlassTabMenu,
  Input,
  MotionConfig,
  Spinner,
  motion,
  useReducedMotion,
} from "@agentdesk/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Flame,
  FolderOpen,
  GraduationCap,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Target,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { InterviewImportDialog, InterviewSettingsDialog } from "./InterviewDialogs";
import { LearningNav } from "./LearningNav";
import { interviewApi } from "./interview-api";
import "./interview.css";

const sourceStatus = {
  queued: "排队中",
  processing: "正在整理",
  ready: "已就绪",
  partial: "部分完成",
  error: "导入失败",
};
const masteryLabel = { new: "未练习", learning: "复习中", mastered: "已掌握" };
const answerLabel = { source: "资料原答案", ai: "AI 参考答案", pending: "待补齐答案" };

export function InterviewPage() {
  const client = useQueryClient();
  const [view, setView] = useState<"questions" | "sources" | "stats">("questions");
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [category, setCategory] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<InterviewSource | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["interview"] });
  const sources = useQuery({
    queryKey: ["interview", "sources"],
    queryFn: interviewApi.sources,
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === "queued" || s.status === "processing")
        ? 2000
        : false,
  });
  const importing = sources.data?.some((s) => s.status === "queued" || s.status === "processing");
  useEffect(() => {
    if (sources.dataUpdatedAt && !importing) {
      void client.invalidateQueries({ queryKey: ["interview", "questions"] });
      void client.invalidateQueries({ queryKey: ["interview", "stats"] });
    }
  }, [client, sources.dataUpdatedAt, importing]);
  const stats = useQuery({
    queryKey: ["interview", "stats"],
    queryFn: interviewApi.stats,
    refetchInterval: importing ? 2000 : 30_000,
  });
  const settings = useQuery({
    queryKey: ["interview", "settings"],
    queryFn: interviewApi.settings,
  });
  const questions = useQuery({
    queryKey: ["interview", "questions", search, filter, category, sourceId, page],
    queryFn: () =>
      interviewApi.questions({ search, filter, category, sourceId, page: String(page) }),
    refetchInterval: importing ? 2000 : false,
  });
  const action = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: interviewApi.remove,
    onSuccess: async () => {
      setDeleting(null);
      setSelected(null);
      await refresh();
    },
  });
  const question = questions.data?.items.find((q) => q.id === selected) ?? questions.data?.items[0];
  const startPractice = () => {
    setView("questions");
    setFilter("due");
    setSearch("");
    setSourceId("");
    setCategory("");
    setSelected(null);
    setPage(1);
  };
  const chooseSource = (id: string) => {
    setSourceId(id);
    setFilter("all");
    setSearch("");
    setCategory("");
    setPage(1);
    setSelected(null);
    setView("questions");
  };
  const errors = [sources.error, stats.error, questions.error, settings.error, action.error].filter(
    Boolean,
  );
  return (
    <MotionConfig reducedMotion="user">
      <div className="iv-page h-full overflow-y-auto">
        <div className="iv-container">
          <header className="iv-heading">
            <div>
              <span className="iv-eyebrow">成长 · INTERVIEW LAB</span>
              <h1>面试题</h1>
            </div>
            <LearningNav />
          </header>
          <GlassSurface className="iv-hero">
            <div className="iv-hero-copy">
              <span className="iv-kicker">
                <Sparkles size={13} /> 每一题，都离从容更近一点
              </span>
              <h2>
                把知识练成<span>你的底气。</span>
              </h2>
              <p>收藏值得思考的问题，用自己的节奏，积累每一次进步。</p>
              <div className="iv-actions">
                <Button
                  variant="brand"
                  size="lg"
                  onClick={startPractice}
                  disabled={!stats.data?.due}
                >
                  开始今日练习 <ArrowRight size={15} />
                </Button>
                <Button size="lg" onClick={() => setImportOpen(true)}>
                  <Plus size={15} /> 导入资料
                </Button>
              </div>
            </div>
            <div className="iv-hero-goal">
              <Target size={22} />
              <span>今日练习</span>
              <div>
                <strong>{stats.data?.todayReviewed ?? "—"}</strong>
                <span> / {stats.data?.dailyGoal ?? "—"} 题</span>
              </div>
              <Progress value={stats.data ? stats.data.todayReviewed / stats.data.dailyGoal : 0} />
              <p>
                {stats.data?.checkedIn ? "今日已打卡，继续保持！" : "完成目标后，记下今天的努力"}
              </p>
            </div>
          </GlassSurface>
          <div className="iv-metrics">
            {[
              { label: "题库总量", value: stats.data?.total, icon: BookOpen, hint: "你的知识储备" },
              {
                label: "已经掌握",
                value: stats.data?.mastered,
                icon: GraduationCap,
                hint: "稳步积累的底气",
              },
              {
                label: "今日待练",
                value: stats.data?.due,
                icon: RotateCcw,
                hint: "新题与到期复习",
              },
              {
                label: "连续打卡",
                value: stats.data?.streak,
                icon: Flame,
                hint: "天 · 让坚持被看见",
              },
            ].map((metric) => (
              <GlassSurface key={metric.label} className="iv-metric">
                <div>
                  <span>{metric.label}</span>
                  <metric.icon size={17} />
                </div>
                <strong>{metric.value ?? "—"}</strong>
                <small>{metric.hint}</small>
              </GlassSurface>
            ))}
          </div>
          <div className="iv-toolbar">
            <GlassTabMenu
              value={view}
              onChange={setView}
              label="面试题视图"
              options={[
                { value: "questions", label: "题库练习" },
                {
                  value: "sources",
                  label: (
                    <>
                      导入资料{" "}
                      {sources.data?.length ? (
                        <span className="iv-tab-count">{sources.data.length}</span>
                      ) : null}
                    </>
                  ),
                },
                { value: "stats", label: "学习统计" },
              ]}
            />
            <Button variant="ghost" disabled={!settings.data} onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} /> 学习设置
            </Button>
          </div>
          {errors.length > 0 && (
            <div role="alert" className="iv-error">
              {errors.map((error, i) => (
                <p key={i}>{error?.message}</p>
              ))}
              <Button size="sm" onClick={() => void refresh()}>
                重新加载
              </Button>
            </div>
          )}
          <div className={view === "stats" ? "" : "iv-layout"}>
            <main className="min-w-0">
              {view === "questions" && (
                <>
                  <div className="iv-filters">
                    <div className="iv-search">
                      <Search size={15} />
                      <Input
                        aria-label="搜索面试题"
                        maxLength={500}
                        placeholder="搜索题目或答案…"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(1);
                          setSelected(null);
                        }}
                      />
                    </div>
                    <select
                      aria-label="题目分类"
                      value={category}
                      onChange={(e) => {
                        setCategory(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="">全部分类</option>
                      {stats.data?.categories.map((c) => (
                        <option key={c.name}>{c.name}</option>
                      ))}
                    </select>
                    <select
                      aria-label="练习筛选"
                      value={filter}
                      onChange={(e) => {
                        setFilter(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="all">全部题目</option>
                      <option value="due">今日待练</option>
                      <option value="favorite">我的收藏</option>
                      <option value="new">未练习</option>
                      <option value="learning">复习中</option>
                      <option value="mastered">已掌握</option>
                    </select>
                  </div>
                  {sourceId && (
                    <div className="mb-3 flex items-center justify-between text-xs text-muted">
                      <span>资料：{sources.data?.find((s) => s.id === sourceId)?.name}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSourceId("");
                          setPage(1);
                        }}
                      >
                        查看全部资料
                      </Button>
                    </div>
                  )}
                  {questions.isLoading ? (
                    <div className="iv-loading">
                      <Spinner /> 正在读取题库
                    </div>
                  ) : !question ? (
                    <GlassSurface className="iv-empty">
                      <BookOpen size={34} className="text-brand" />
                      <h3>
                        {stats.data?.total ? "这一组题目已经看完了" : "从你的第一份面试资料开始"}
                      </h3>
                      <p>
                        {stats.data?.total
                          ? "换个筛选继续探索，或导入新的面试题。"
                          : "支持批量文件、网页和飞书文档，有答案就保留，没答案就补齐。"}
                      </p>
                      <Button onClick={() => setImportOpen(true)}>
                        <Plus size={14} /> 导入面试资料
                      </Button>
                    </GlassSurface>
                  ) : (
                    <>
                      <QuestionCard
                        key={question.id}
                        question={question}
                        timeZone={settings.data?.timeZone ?? "Asia/Shanghai"}
                        onChange={() => void refresh()}
                        onNext={() => {
                          const items = questions.data!.items;
                          const index = items.findIndex((q) => q.id === question.id);
                          setSelected(items[index + 1]?.id ?? items[0]?.id ?? null);
                        }}
                      />
                      <div className="iv-list-heading">
                        <h3>题目列表</h3>
                        <span>{questions.data?.total} 道题</span>
                      </div>
                      <GlassSurface className="iv-question-list">
                        {questions.data?.items.map((q, i) => (
                          <button
                            key={q.id}
                            aria-pressed={q.id === question.id}
                            className="iv-question-row"
                            onClick={() => setSelected(q.id)}
                          >
                            <span className="iv-index">
                              {String((questions.data!.page - 1) * 20 + i + 1).padStart(2, "0")}
                            </span>
                            <span className="iv-question-title">
                              {q.question}
                              <small>
                                {q.category} · {answerLabel[q.answerOrigin]}
                              </small>
                            </span>
                            {q.favorite && (
                              <Star size={13} className="text-amber-500" fill="currentColor" />
                            )}
                            <span className={`iv-mastery iv-mastery-${q.mastery}`}>
                              {masteryLabel[q.mastery]}
                            </span>
                            <ChevronRight size={14} />
                          </button>
                        ))}
                      </GlassSurface>
                      <div className="iv-pagination">
                        <Button
                          size="icon"
                          aria-label="上一页"
                          disabled={questions.data!.page <= 1}
                          onClick={() => {
                            setPage(questions.data!.page - 1);
                            setSelected(null);
                          }}
                        >
                          <ChevronLeft size={15} />
                        </Button>
                        <span>
                          {questions.data!.page} / {questions.data!.pages}
                        </span>
                        <Button
                          size="icon"
                          aria-label="下一页"
                          disabled={questions.data!.page >= questions.data!.pages}
                          onClick={() => {
                            setPage(questions.data!.page + 1);
                            setSelected(null);
                          }}
                        >
                          <ChevronRight size={15} />
                        </Button>
                      </div>
                    </>
                  )}
                </>
              )}
              {view === "sources" && (
                <div className="space-y-3">
                  <div className="iv-list-heading">
                    <div>
                      <h3>每份资料，都有来处</h3>
                      <p>导入进度、原文与补齐情况，都在这里。</p>
                    </div>
                    <Button onClick={() => setImportOpen(true)}>
                      <Plus size={14} /> 批量导入
                    </Button>
                  </div>
                  {!sources.data?.length ? (
                    <EmptyState
                      icon={<FolderOpen size={32} />}
                      title="还没有导入资料"
                      description="导入文件或链接，开始积累自己的面试题库。"
                    />
                  ) : (
                    sources.data.map((s) => (
                      <GlassSurface key={s.id} className="iv-source">
                        <div className="iv-source-head">
                          <span className="iv-source-icon">
                            <FileText size={20} />
                          </span>
                          <div>
                            <h3>{s.name}</h3>
                            <p>
                              {s.kind === "url"
                                ? s.origin
                                : s.kind === "file"
                                  ? "本地文件"
                                  : "粘贴文本"}
                            </p>
                          </div>
                          <Badge
                            tone={
                              s.status === "error" || s.status === "partial" ? "warning" : "neutral"
                            }
                          >
                            {sourceStatus[s.status]}
                          </Badge>
                        </div>
                        <div className="iv-source-progress">
                          <span>
                            {s.questionCount} 道题 · {s.processedParts}/{s.totalParts || "—"} 部分
                          </span>
                          {["queued", "processing"].includes(s.status) && <Spinner />}
                        </div>
                        <Progress value={s.totalParts ? s.processedParts / s.totalParts : 0} />
                        {s.error && (
                          <p role="alert" className="mt-3 text-xs text-danger">
                            {s.error}
                          </p>
                        )}
                        {s.warnings.length > 0 && (
                          <details className="iv-source-notes">
                            <summary>查看 {s.warnings.length} 条处理说明</summary>
                            <ul>
                              {s.warnings.map((warning, i) => (
                                <li key={i}>{warning}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <div className="iv-source-actions">
                          <Button
                            size="sm"
                            disabled={!s.questionCount}
                            onClick={() => chooseSource(s.id)}
                          >
                            查看题目 <ArrowRight size={13} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              action.isPending || ["queued", "processing"].includes(s.status)
                            }
                            onClick={() => action.mutate(() => interviewApi.retry(s.id))}
                          >
                            <RotateCcw size={13} /> 重试 / 补齐
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`删除资料 ${s.name}`}
                            disabled={["queued", "processing"].includes(s.status)}
                            onClick={() => {
                              remove.reset();
                              setDeleting(s);
                            }}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </GlassSurface>
                    ))
                  )}
                </div>
              )}
              {view === "stats" && stats.data && (
                <div className="iv-stat-layout">
                  <StudyProgress
                    stats={stats.data}
                    pending={action.isPending}
                    onCheckin={() => action.mutate(interviewApi.checkin)}
                  />
                  <GlassSurface className="iv-panel">
                    <span className="iv-eyebrow">KNOWLEDGE MAP</span>
                    <h3>知识领域</h3>
                    <p>每个领域，慢慢变得更有把握。</p>
                    {stats.data.categories.length ? (
                      stats.data.categories.map((c) => (
                        <div key={c.name} className="iv-category">
                          <div>
                            <span>{c.name}</span>
                            <small>
                              {c.mastered} / {c.total} 已掌握
                            </small>
                          </div>
                          <Progress value={c.mastered / c.total} />
                        </div>
                      ))
                    ) : (
                      <p className="py-8">导入题目后，分类统计会出现在这里。</p>
                    )}
                    <div className="iv-answer-counts">
                      <span>
                        <b>{stats.data.sourceAnswers}</b> 原答案
                      </span>
                      <span>
                        <b>{stats.data.aiAnswers}</b> AI 补齐
                      </span>
                      <span>
                        <b>{stats.data.pendingAnswers}</b> 待补齐
                      </span>
                    </div>
                  </GlassSurface>
                </div>
              )}
            </main>
            {view !== "stats" && (
              <aside className="space-y-4">
                {stats.data && (
                  <StudyProgress
                    stats={stats.data}
                    pending={action.isPending}
                    onCheckin={() => action.mutate(interviewApi.checkin)}
                  />
                )}
                <GlassSurface className="iv-folder-panel">
                  <h3>我的资料夹</h3>
                  <p>让零散的收藏，成为有序的积累。</p>
                  <GlassFolder
                    label="面试资料"
                    open={folderOpen}
                    onOpenChange={setFolderOpen}
                    items={(sources.data ?? [])
                      .slice(0, 6)
                      .map((s) => ({ id: s.id, name: s.name, meta: `${s.questionCount} 道题` }))}
                    onSelect={chooseSource}
                    scale={0.58}
                    emptyText="导入你的第一份资料"
                  />
                  <Button variant="ghost" size="sm" onClick={() => setView("sources")}>
                    查看全部 {sources.data?.length ?? 0} 份资料 <ArrowRight size={13} />
                  </Button>
                </GlassSurface>
              </aside>
            )}
          </div>
          {importOpen && (
            <InterviewImportDialog
              onClose={() => setImportOpen(false)}
              onImported={() => {
                setView("sources");
                void refresh();
              }}
            />
          )}
          {settingsOpen && settings.data && (
            <InterviewSettingsDialog
              settings={settings.data}
              onClose={() => setSettingsOpen(false)}
              onSaved={() => void refresh()}
            />
          )}
          {deleting && (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open && !remove.isPending) setDeleting(null);
              }}
              title="删除这份资料？"
              description={`「${deleting.name}」及其题目会被删除，已完成的练习和打卡记录会保留。`}
              footer={
                <>
                  <Button onClick={() => setDeleting(null)} disabled={remove.isPending}>
                    取消
                  </Button>
                  <Button
                    variant="danger"
                    loading={remove.isPending}
                    onClick={() => remove.mutate(deleting.id)}
                  >
                    删除资料和题目
                  </Button>
                </>
              }
            >
              <p className="text-sm text-muted">需要时可以重新导入原始文件或链接。</p>
              {remove.error && (
                <p role="alert" className="text-danger">
                  {remove.error.message}
                </p>
              )}
            </Dialog>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <div
      className="iv-progress"
      role="progressbar"
      aria-label="完成进度"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, Math.max(0, value)) * 100)}
    >
      <span style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }} />
    </div>
  );
}

function StudyProgress({
  stats,
  pending,
  onCheckin,
}: {
  stats: InterviewStats;
  pending: boolean;
  onCheckin: () => void;
}) {
  return (
    <GlassSurface className="iv-panel">
      <div className="iv-panel-heading">
        <h3>坚持有迹可循</h3>
        <Flame size={17} className="text-amber-500" />
      </div>
      <p>最近 12 周 · 今天 {stats.todayReviewed} 道</p>
      <div className="iv-heatmap" aria-label="最近 84 天练习记录">
        {stats.days.map((day) => (
          <span
            key={day.date}
            tabIndex={0}
            role="img"
            aria-label={`${day.date}：${day.count} 道题${day.checkedIn ? "，已打卡" : ""}`}
            title={`${day.date} · ${day.count} 道题${day.checkedIn ? " · 已打卡" : ""}`}
            data-level={day.checkedIn ? 3 : day.count >= 3 ? 2 : day.count ? 1 : 0}
          />
        ))}
      </div>
      <div className="iv-heatmap-legend">
        <span>少</span>
        {[0, 1, 2, 3].map((level) => (
          <i key={level} data-level={level} />
        ))}
        <span>多 / 已打卡</span>
      </div>
      <Button
        className="w-full"
        variant={stats.checkedIn ? "secondary" : "brand"}
        loading={pending}
        disabled={stats.checkedIn || stats.todayReviewed < stats.dailyGoal}
        onClick={onCheckin}
      >
        {stats.checkedIn ? (
          <>
            <Check size={15} /> 今日已打卡
          </>
        ) : (
          <>
            完成今日打卡 <ArrowRight size={14} />
          </>
        )}
      </Button>
      <p className="iv-checkin-note">
        {stats.checkedIn
          ? `连续 ${stats.streak} 天，进步正在发生。`
          : `每日目标 ${stats.dailyGoal} 题，还需 ${Math.max(0, stats.dailyGoal - stats.todayReviewed)} 题。`}
      </p>
    </GlassSurface>
  );
}

function QuestionCard({
  question,
  timeZone,
  onChange,
  onNext,
}: {
  question: InterviewQuestion;
  timeZone: string;
  onChange: () => void;
  onNext: () => void;
}) {
  const reduced = useReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const request = useRef<{ rating: InterviewReviewInput["rating"]; id: string } | null>(null);
  const favorite = useMutation({
    mutationFn: () => interviewApi.favorite(question.id, !question.favorite),
    onSuccess: onChange,
  });
  const review = useMutation({
    mutationFn: (rating: InterviewReviewInput["rating"]) => {
      // 网络重试沿用相同标识，避免一次点击被计为两次练习。
      if (!request.current || request.current.rating !== rating)
        request.current = { rating, id: crypto.randomUUID() };
      return interviewApi.review(question.id, { rating, requestId: request.current.id, timeZone });
    },
    onSuccess: () => {
      setRecorded(true);
      onChange();
    },
  });
  return (
    <GlassSurface className="iv-practice" elevated>
      <div className="iv-practice-meta">
        <div>
          <Badge tone="brand">{question.category}</Badge>
          <span>
            {masteryLabel[question.mastery]} · 已练 {question.reviews} 次
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={question.favorite ? "取消收藏" : "收藏题目"}
          aria-pressed={question.favorite}
          disabled={favorite.isPending}
          onClick={() => favorite.mutate()}
        >
          <Star
            size={17}
            fill={question.favorite ? "currentColor" : "none"}
            className={question.favorite ? "text-amber-500" : ""}
          />
        </Button>
      </div>
      <h2>{question.question}</h2>
      <p className="iv-source-label">来自 {question.sourceName}</p>
      {!revealed && (
        <div className="iv-think">
          <span>给自己一点思考的时间</span>
          <p>先试着回答，再对照答案找出遗漏。</p>
          <Button onClick={() => setRevealed(true)}>
            <BookOpen size={15} /> 展开参考答案
          </Button>
        </div>
      )}
      <AnimatePresence initial={false}>
        {revealed && (
          <motion.div
            key="answer"
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="iv-answer"
          >
            <div className="iv-answer-heading">
              <Badge tone={question.answerOrigin === "pending" ? "warning" : "neutral"}>
                {answerLabel[question.answerOrigin]}
              </Badge>
              {question.answerOrigin === "ai" && <small>由模型生成，请结合实际场景核对。</small>}
            </div>
            {question.answer ? (
              <div className="iv-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: ({ alt }) => <span>[图片：{alt}]</span>,
                    a: ({ children, href }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {question.answer}
                </ReactMarkdown>
              </div>
            ) : (
              <p className="py-4 text-sm text-muted">
                这道题还没有答案。配置可用模型后，在「导入资料」中点击「重试 / 补齐」。
              </p>
            )}
            <details className="iv-excerpt">
              <summary>查看资料原文</summary>
              <pre>{question.sourceExcerpt}</pre>
              {/^https?:\/\//i.test(question.origin) && (
                <a href={question.origin} target="_blank" rel="noopener noreferrer">
                  打开来源链接 ↗
                </a>
              )}
            </details>
            {question.answerOrigin !== "pending" && (
              <div className="iv-review">
                {recorded ? (
                  <div className="iv-recorded" role="status">
                    <span>
                      <Check size={15} /> 练习已记录
                    </span>
                    <Button size="sm" onClick={onNext}>
                      下一题 <ArrowRight size={14} />
                    </Button>
                  </div>
                ) : (
                  <>
                    <p>这道题，你掌握得怎么样？</p>
                    <div>
                      <Button
                        size="sm"
                        disabled={review.isPending}
                        onClick={() => review.mutate("again")}
                      >
                        还需复习 · 1 天后
                      </Button>
                      <Button
                        size="sm"
                        disabled={review.isPending}
                        onClick={() => review.mutate("good")}
                      >
                        基本掌握 · 3 天后
                      </Button>
                      <Button
                        size="sm"
                        variant="brand"
                        disabled={review.isPending}
                        onClick={() => review.mutate("easy")}
                      >
                        熟练掌握 · 7 天后
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {(favorite.error || review.error) && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {favorite.error?.message || review.error?.message}
        </p>
      )}
    </GlassSurface>
  );
}
