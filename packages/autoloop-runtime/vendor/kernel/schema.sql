-- The columns of the read-only SQL views over the projections. host/runtime.ts reads the table and column names and makes
-- each table here a view; nothing is executed as written, which is why there are no indexes and no migrations.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  routed TEXT NOT NULL DEFAULT '[]',
  received_at TEXT NOT NULL,
  UNIQUE (source, key)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  agent TEXT NOT NULL,
  grp TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,
  claim TEXT,
  last_result TEXT,
  cancel_at TEXT,
  resume TEXT,
  session TEXT,
  link TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  seen_at TEXT,
  finished_at TEXT,
  summary TEXT,
  error TEXT,
  usage TEXT
);

CREATE TABLE run_events (
  run_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, event_id)
);

CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  recommend INTEGER,
  about TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  fyi INTEGER NOT NULL DEFAULT 0,
  quiet INTEGER NOT NULL DEFAULT 0,
  choice INTEGER,
  answer TEXT,
  by TEXT,
  result TEXT,
  rule TEXT,
  lane TEXT NOT NULL DEFAULT '',
  grp TEXT,
  source TEXT,
  agent TEXT,
  session TEXT,
  run_id INTEGER,
  answer_event INTEGER,
  token TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  closed_at TEXT
);

CREATE TABLE deliveries (
  card_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  ref TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  first_try_at TEXT,
  not_before TEXT,
  error TEXT,
  given_up INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (card_id, channel)
);

CREATE TABLE timers (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  source TEXT NOT NULL,
  session TEXT,
  about TEXT NOT NULL,
  at TEXT NOT NULL,
  event_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE schedules (
  rule TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  next_at TEXT NOT NULL
);

CREATE TABLE seen (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

CREATE TABLE keys (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

