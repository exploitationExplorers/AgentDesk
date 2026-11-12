import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadGatewayConfig } from "./config";
import { createPostgresDatabase } from "./db/database";
import { GatewayStore } from "./db/store";
import { DeviceStore } from "./devices/store";
import { RemoteRoutingStore } from "./remote/store";
import { GatewayTransfers } from "./remote/transfers";
import { RemoteGatewayService } from "./remote/service";
import { RunnerClient } from "./remote/client";
import { createGatewayAuth } from "./auth/service";
import { migrateGateway } from "./db/migrate";

const [backup, report] = process.argv.slice(2);
if (!backup || !report || process.argv.length !== 4)
  throw new Error(
    "Usage: migrate.mjs <read-only-sqlite-backup> <report.json>; stop Gateway before production migration",
  );
const config = loadGatewayConfig();
if (!config.databaseUrl) throw new Error("Migration requires DATABASE_URL_FILE");
writeFileSync(
  resolve(report),
  JSON.stringify({ status: "pending", timestamp: new Date().toISOString() }),
  { mode: 0o600, flag: "wx" },
);
const target = await createPostgresDatabase(config.databaseUrl, config.databaseSchema);
const source = new Database(resolve(backup), { readonly: true, fileMustExist: true });
try {
  const store = new GatewayStore(target, config.otpPepper);
  const devices = new DeviceStore(target, config.otpPepper, config.publicOrigin);
  const routing = new RemoteRoutingStore(target);
  const remote = new RemoteGatewayService(new RunnerClient(config), routing);
  const transfers = new GatewayTransfers(target, remote, routing);
  await Promise.all([store.ready, devices.ready, routing.ready, transfers.ready]);
  await createGatewayAuth(
    config,
    target,
    async () => {
      throw new Error("OTP disabled during migration");
    },
    { initializeOwner: false },
  );
  const result = await migrateGateway(source, target);
  writeFileSync(
    resolve(report),
    JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2),
    { mode: 0o600, flag: "w" },
  );
  console.info(`Verified ${result.tables.length} Gateway tables; migration committed`);
} finally {
  source.close();
  await target.close();
}
