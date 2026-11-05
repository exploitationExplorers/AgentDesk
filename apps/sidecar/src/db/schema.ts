import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 配置类实体（Provider、项目、服务器、配方、工作流等）以文档形式存储。 */
export const documents = sqliteTable(
  "documents",
  {
    collection: text("collection").notNull(),
    id: text("id").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.id] })],
);

/** AES-256-GCM 密文，主密钥保存在系统钥匙串中 */
export const secrets = sqliteTable("secrets", {
  id: text("id").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    agent: text("agent"),
    toolCalls: text("tool_calls", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const feedItems = sqliteTable(
  "feed_items",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    source: text("source").notNull(),
    key: text("key").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    description: text("description").notNull(),
    summaryZh: text("summary_zh"),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    language: text("language"),
    stars: integer("stars"),
    starsToday: integer("stars_today"),
    rank: integer("rank").notNull(),
    favorite: integer("favorite", { mode: "boolean" }).notNull(),
  },
  (t) => [index("feed_date_idx").on(t.date, t.source)],
);

/**
 * 长期记忆。tokens 是空格分隔的检索词（英文词 + 中文双字），
 * 供 FTS5 做 BM25；unicode61 会把一整句中文当成一个词，所以不直接索引正文。
 */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    namespace: text("namespace").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    tokens: text("tokens").notNull(),
    source: text("source").notNull(),
    conversationId: text("conversation_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("memories_namespace_idx").on(t.namespace, t.updatedAt)],
);

export const traces = sqliteTable(
  "traces",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope").notNull(),
    event: text("event", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("traces_scope_idx").on(t.scope)],
);

/** Task 之下的一次执行（root 或 delegate 子任务）。 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    parentRunId: text("parent_run_id"),
    kind: text("kind", { enum: ["root", "delegate"] }).notNull(),
    agent: text("agent").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    trigger: text("trigger", {
      enum: ["create", "continue", "followup", "resume", "delegate"],
    }).notNull(),
    idempotencyKey: text("idempotency_key"),
    input: text("input", { mode: "json" }).notNull(),
    resultText: text("result_text"),
    resultError: text("result_error"),
    toolCalls: text("tool_calls", { mode: "json" }),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    cancelRequestedAt: text("cancel_requested_at"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("runs_task_idx").on(t.taskId, t.createdAt),
    index("runs_parent_idx").on(t.parentRunId),
    uniqueIndex("runs_idempotency_idx").on(t.idempotencyKey),
  ],
);

/** Run 的事件日志，供后续断线补取使用（本阶段尚未接入写入方）。 */
export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    runId: text("run_id").notNull(),
    parentRunId: text("parent_run_id"),
    event: text("event", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("run_events_run_idx").on(t.runId, t.id),
    index("run_events_task_idx").on(t.taskId, t.id),
  ],
);

/** 任务产出的方案、变更、测试结果等版本化产物。 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    runId: text("run_id"),
    kind: text("kind", { enum: ["plan", "change", "test_result", "file", "summary"] }).notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content"),
    filePath: text("file_path"),
    mimeType: text("mime_type"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("artifacts_task_kind_idx").on(t.taskId, t.kind, t.version)],
);

/** 成长中心：一个职业画像，同一个人可有多个（例如同时提升职业英语和算法）。 */
export const learningProfiles = sqliteTable("learning_profiles", {
  id: text("id").primaryKey(),
  profession: text("profession").notNull(),
  targetRole: text("target_role"),
  dailyBudgetMin: integer("daily_budget_min").notNull(),
  createdAt: text("created_at").notNull(),
});

/** 学习计划主记录，内容快照在 learning_plan_versions 里，这里只存指针。 */
export const learningPlans = sqliteTable(
  "learning_plans",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id").notNull(),
    skillName: text("skill_name").notNull(),
    status: text("status", {
      enum: ["draft", "active", "paused", "completed", "abandoned"],
    }).notNull(),
    currentVersionId: text("current_version_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("learning_plans_profile_idx").on(t.profileId, t.status)],
);

/** 计划版本快照，不可变。调整目标时新插一条，而不是覆盖历史。 */
export const learningPlanVersions = sqliteTable(
  "learning_plan_versions",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    goal: text("goal").notNull(),
    milestones: text("milestones", { mode: "json" })
      .$type<Array<{ label: string; focus: string }>>()
      .notNull(),
    durationDays: integer("duration_days").notNull(),
    changeReason: text("change_reason"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("learning_plan_versions_plan_idx").on(t.planId, t.createdAt)],
);

/** 某一天要做的一件具体的事。永远指向生成它的那个计划版本。 */
export const learningActivities = sqliteTable(
  "learning_activities",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    planVersionId: text("plan_version_id").notNull(),
    date: text("date").notNull(),
    orderIndex: integer("order_index").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    type: text("type", { enum: ["reading", "practice", "quiz", "review"] }).notNull(),
    estMinutes: integer("est_minutes").notNull(),
    status: text("status", { enum: ["pending", "done", "skipped"] }).notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [index("learning_activities_date_idx").on(t.date, t.planId, t.orderIndex)],
);

/** 每个自然日的打卡聚合，只有产生过有效学习会话才写入。 */
export const learningCheckins = sqliteTable("learning_checkins", {
  date: text("date").primaryKey(),
  effectiveMinutes: integer("effective_minutes").notNull(),
  activitiesDone: integer("activities_done").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** 导入的一份学习资料（网页链接、粘贴的正文等）。 */
export const learningSources = sqliteTable("learning_sources", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["url", "text"] }).notNull(),
  /** URL 或「粘贴文本」。 */
  originRef: text("origin_ref").notNull(),
  title: text("title").notNull(),
  currentVersionId: text("current_version_id").notNull(),
  createdAt: text("created_at").notNull(),
});

/** 每次抓取/粘贴的不可变快照。同一来源更新时新增版本，不覆盖旧版。 */
export const sourceVersions = sqliteTable(
  "source_versions",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    contentHash: text("content_hash").notNull(),
    charCount: integer("char_count").notNull(),
    blockCount: integer("block_count").notNull(),
    /** 解析质量：ok 正常，partial 可能缺内容。 */
    parseQuality: text("parse_quality", { enum: ["ok", "partial"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("source_versions_source_idx").on(t.sourceId, t.createdAt)],
);

/** 资料解析后最小的可引用单元。知识单元和练习都必须能回溯到某个块。 */
export const contentBlocks = sqliteTable(
  "content_blocks",
  {
    id: text("id").primaryKey(),
    sourceVersionId: text("source_version_id").notNull(),
    orderIndex: integer("order_index").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("content_blocks_version_idx").on(t.sourceVersionId, t.orderIndex)],
);

/** 从内容块提炼出的一个知识点。blockId 是它的原文出处，不允许为空。 */
export const knowledgeUnits = sqliteTable(
  "knowledge_units",
  {
    id: text("id").primaryKey(),
    sourceVersionId: text("source_version_id").notNull(),
    /** 该知识点所依据的内容块——「点一下看原文」靠这个字段。 */
    blockId: text("block_id").notNull(),
    orderIndex: integer("order_index").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** 自测问题，用于复习时出题。 */
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("knowledge_units_version_idx").on(t.sourceVersionId, t.orderIndex)],
);

/** 每个知识点的 FSRS 记忆状态。 */
export const reviewItems = sqliteTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    knowledgeUnitId: text("knowledge_unit_id").notNull().unique(),
    /** 稳定性（天）。null 表示还没复习过。 */
    stability: real("stability"),
    difficulty: real("difficulty"),
    /** 下次到期的本地日期 YYYY-MM-DD。 */
    dueDate: text("due_date").notNull(),
    lastReviewedAt: text("last_reviewed_at"),
    reps: integer("reps").notNull(),
    lapses: integer("lapses").notNull(),
  },
  (t) => [index("review_items_due_idx").on(t.dueDate)],
);

/** 每一次复习的评分记录，将来做个性化权重优化的训练数据，完全留在本地。 */
export const reviewLogs = sqliteTable(
  "review_logs",
  {
    id: text("id").primaryKey(),
    reviewItemId: text("review_item_id").notNull(),
    rating: integer("rating").notNull(),
    elapsedDays: integer("elapsed_days").notNull(),
    retrievability: real("retrievability").notNull(),
    stabilityAfter: real("stability_after").notNull(),
    reviewedAt: text("reviewed_at").notNull(),
  },
  (t) => [index("review_logs_item_idx").on(t.reviewItemId, t.reviewedAt)],
);

export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent TEXT,
  tool_calls TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL,
  summary_zh TEXT,
  tags TEXT NOT NULL,
  language TEXT,
  stars INTEGER,
  stars_today INTEGER,
  rank INTEGER NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS feed_date_idx ON feed_items(date, source);
CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_scope_idx ON traces(scope);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tokens TEXT NOT NULL,
  source TEXT NOT NULL,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_namespace_idx ON memories(namespace, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  tokens,
  content='memories',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, tokens) VALUES (new.rowid, new.tokens);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, tokens) VALUES ('delete', old.rowid, old.tokens);
  INSERT INTO memories_fts(rowid, tokens) VALUES (new.rowid, new.tokens);
END;
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  parent_run_id TEXT,
  kind TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  idempotency_key TEXT,
  input TEXT NOT NULL,
  result_text TEXT,
  result_error TEXT,
  tool_calls TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_task_idx ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS runs_parent_idx ON runs(parent_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_idx ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_run_id TEXT,
  event TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, id);
CREATE INDEX IF NOT EXISTS run_events_task_idx ON run_events(task_id, id);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  file_path TEXT,
  mime_type TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_task_kind_idx ON artifacts(task_id, kind, version);
CREATE TABLE IF NOT EXISTS learning_profiles (
  id TEXT PRIMARY KEY,
  profession TEXT NOT NULL,
  target_role TEXT,
  daily_budget_min INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_plans (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  status TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS learning_plans_profile_idx ON learning_plans(profile_id, status);
CREATE TABLE IF NOT EXISTS learning_plan_versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  milestones TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  change_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS learning_plan_versions_plan_idx ON learning_plan_versions(plan_id, created_at);
CREATE TABLE IF NOT EXISTS learning_activities (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  date TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  type TEXT NOT NULL,
  est_minutes INTEGER NOT NULL,
  status TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS learning_activities_date_idx ON learning_activities(date, plan_id, order_index);
CREATE TABLE IF NOT EXISTS learning_checkins (
  date TEXT PRIMARY KEY,
  effective_minutes INTEGER NOT NULL,
  activities_done INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  origin_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  block_count INTEGER NOT NULL,
  parse_quality TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_versions_source_idx ON source_versions(source_id, created_at);
CREATE TABLE IF NOT EXISTS content_blocks (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS content_blocks_version_idx ON content_blocks(source_version_id, order_index);
CREATE TABLE IF NOT EXISTS knowledge_units (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_units_version_idx ON knowledge_units(source_version_id, order_index);
CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  knowledge_unit_id TEXT NOT NULL UNIQUE,
  stability REAL,
  difficulty REAL,
  due_date TEXT NOT NULL,
  last_reviewed_at TEXT,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS review_items_due_idx ON review_items(due_date);
CREATE TABLE IF NOT EXISTS review_logs (
  id TEXT PRIMARY KEY,
  review_item_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  elapsed_days INTEGER NOT NULL,
  retrievability REAL NOT NULL,
  stability_after REAL NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_logs_item_idx ON review_logs(review_item_id, reviewed_at);
`;
