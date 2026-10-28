import {
  index,
  integer,
  primaryKey,
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
`;
