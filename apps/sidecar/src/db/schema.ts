import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
`;
