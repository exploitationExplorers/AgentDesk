import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAutoloopRuntime } from "../packages/autoloop-runtime/src/index";
import { openDatabase } from "../apps/sidecar/src/db/client";
import { EventHub } from "../apps/sidecar/src/events";
import { TaskService } from "../apps/sidecar/src/services/tasks";
import { TaskSubmissionService } from "../apps/sidecar/src/services/task-submissions";

assert.equal(process.platform, "linux", "C0 smoke must run on real Linux");
assert.equal(process.arch, "x64", "C0 currently validates linux/amd64 only");
assert.notEqual(process.getuid?.(), 0, "Run the smoke as the non-root runtime user");
const bundle = resolve(process.argv[2] ?? "apps/sidecar/dist");
const manifest = JSON.parse(readFileSync(join(bundle, "runtime-manifest.json"), "utf8"));
assert.equal(manifest.sidecar.platform, "linux");
assert.equal(manifest.sidecar.arch, "x64");
assert.equal(manifest.sidecar.modules, process.versions.modules);
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
assert.equal(hash(join(bundle, "node")), manifest.sidecar.nodeSha256);
assert.equal(
  hash(join(bundle, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")),
  manifest.sidecar.betterSqlite3Sha256,
);
for (const [file, digest] of Object.entries(manifest.autoloop.files))
  assert.equal(hash(join(bundle, "autoloop", file)), digest);
assert.ok(existsSync(join(bundle, "autoloop/Node-LICENSE.txt")));
assert.ok(existsSync(join(bundle, "skills")));
execFileSync(join(bundle, "node"), ["--check", join(bundle, "scripts/ai-commit-worker.mjs")]);

const directory = mkdtempSync(join(tmpdir(), "agentdesk-linux-smoke-"));
const Sqlite = createRequire(join(bundle, "index.mjs"))("better-sqlite3");
const native = new Sqlite(join(directory, "native.db"));
try {
  native.pragma("journal_mode=WAL");
  native.exec("CREATE TABLE smoke(value TEXT); INSERT INTO smoke VALUES ('linux-native-sqlite')");
  assert.equal(native.prepare("SELECT value FROM smoke").get().value, "linux-native-sqlite");
} finally {
  native.close();
}

const credentials = {
  owner: randomBytes(32).toString("hex"),
  source: randomBytes(32).toString("hex"),
  worker: randomBytes(32).toString("hex"),
};
const rules = {
  sources: { agentdesk: { name: "AgentDesk" } },
  agents: {
    agentdesk: { name: "AgentDesk", worker: "agentdesk", use: "agentdesk", access: "edit" },
  },
  rules: [],
};
const runtimeOptions = {
  dataDir: join(directory, "autoloop"),
  hostPath: join(bundle, "autoloop/host.mjs"),
  nodePath: join(bundle, "autoloop/node"),
  credentials,
  rules,
};
let runtime: Awaited<ReturnType<typeof startAutoloopRuntime>> | undefined;
let database: ReturnType<typeof openDatabase> | undefined;
try {
  runtime = await startAutoloopRuntime(runtimeOptions);
  await runtime.updateRules(rules);
  await runtime.stop();
  runtime = await startAutoloopRuntime(runtimeOptions);
  database = openDatabase(directory);
  const tasks = new TaskService(database.db, new EventHub(), {
    maxConcurrentRuns: 1,
    executor: async () => {
      const text = execFileSync("sh", ["-c", "printf linux-task-smoke"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 5_000,
      });
      return { status: "succeeded", resultText: text };
    },
  });
  const submissions = new TaskSubmissionService(database, tasks);
  const first = submissions.submit({
    goal: "Linux task persistence smoke",
    idempotencyKey: "linux-smoke",
  });
  tasks.enqueue(first.run.id);
  const deadline = Date.now() + 5_000;
  while (tasks.getRun(first.run.id)?.status !== "succeeded" && Date.now() < deadline)
    await delay(20);
  assert.equal(tasks.getRun(first.run.id)?.resultText, "linux-task-smoke");
  database.close();
  database = openDatabase(directory);
  const restarted = new TaskService(database.db, new EventHub());
  assert.equal(restarted.getRun(first.run.id)?.status, "succeeded");
  const replay = new TaskSubmissionService(database, restarted).submit({
    goal: "Linux task persistence smoke",
    idempotencyKey: "linux-smoke",
  });
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.replayed, true);
  console.info(
    "Linux C0 smoke passed: packaged checksums, native SQLite, Autoloop restart, task execution and persistence, commit worker resources.",
  );
} finally {
  await runtime?.stop();
  if (database?.raw.open) database.close();
  rmSync(directory, { recursive: true, force: true });
}
