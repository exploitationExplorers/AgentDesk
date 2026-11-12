import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCloudConfig } from "../src/cloud-config";
const root = mkdtempSync(join(tmpdir(), "runner-db-config-"));
const master = join(root, "master"),
  token = join(root, "token");
writeFileSync(master, randomBytes(32).toString("base64"));
writeFileSync(token, randomBytes(32).toString("hex"));
const env = {
  AGENTDESK_DATA_DIR: root,
  WORKSPACE_ROOT: root,
  AGENTDESK_MASTER_KEY_FILE: master,
  REMOTE_SHARED_TOKEN_FILE: token,
  CLOUD_OWNER_USER_ID: "owner",
};
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("cloud database configuration", () => {
  it("requires PostgreSQL in production and rejects malformed or ambiguous configuration", () => {
    for (const database of [
      { NODE_ENV: "production" },
      { DATABASE_URL: "" },
      { DATABASE_URL: "sqlite:///data.db" },
      { DATABASE_URL: "postgres://localhost/db?options=search_path%3Dpublic" },
      { DATABASE_URL: "postgres://localhost/db", DATABASE_URL_FILE: "unused" },
      { DATABASE_SCHEMA: "runner" },
      { DATABASE_URL: "postgres://localhost/db", DATABASE_SCHEMA: "runner;DROP SCHEMA public" },
    ])
      expect(() => loadCloudConfig({ ...env, ...database })).toThrow();
  });
  it("reads a mounted secret and fails closed when it disappears", () => {
    const file = join(root, "database-url");
    writeFileSync(file, "postgresql://runner:fixture@postgres:5432/agentdesk\n");
    const config = loadCloudConfig({
      ...env,
      NODE_ENV: "production",
      DATABASE_URL_FILE: file,
      DATABASE_SCHEMA: "runner",
    });
    expect(config.databaseSchema).toBe("runner");
    expect(config.databaseUrl).toBe("postgresql://runner:fixture@postgres:5432/agentdesk");
    rmSync(file);
    expect(() => loadCloudConfig({ ...env, DATABASE_URL_FILE: file })).toThrow();
  });
});
