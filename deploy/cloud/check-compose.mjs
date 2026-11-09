// 本地隔离演练只操作随机创建的 Compose project 与命名卷。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const root = resolve("deploy/cloud");
const temporary = await mkdtemp(join(tmpdir(), "agentdesk-compose-check-"));
const name = "agentdesk-check-" + randomUUID().slice(0, 8),
  volume = name + "-data";
let created = false,
  compose;
async function docker(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error("docker " + args.slice(0, 3).join(" ") + " failed\n" + output.slice(-6000)),
          ),
    );
  });
}
const run = (args) =>
  docker([
    "run",
    "--rm",
    "--user",
    "0",
    "--mount",
    "type=volume,source=" + volume + ",target=/validation",
    "--mount",
    "type=bind,source=" + root + ",target=/checks,readonly",
    ...args,
  ]);
try {
  await docker(["volume", "create", volume]);
  created = true;
  await run([
    "--network",
    "none",
    "--mount",
    "type=bind,source=" + temporary + ",target=/outputs",
    "--entrypoint",
    "python3",
    "agentdesk-runner:local-validation",
    "/checks/tests/initialize.py",
  ]);
  const config = JSON.parse(
    await docker(["compose", "-f", join(root, "compose.yaml"), "config", "--format", "json"], {
      DEPLOY_ROOT: temporary,
      AGENTDESK_RELEASE: "local-validation",
    }),
  );
  delete config.name;
  config.volumes = { validation: { external: true, name: volume } };
  config.networks.agentdesk = {
    internal: true,
    ipam: { config: [{ subnet: "172.29.197.0/24", gateway: "172.29.197.1" }] },
  };
  const mount = (subpath, target, readOnly = false) => ({
    type: "volume",
    source: "validation",
    target,
    read_only: readOnly,
    volume: { nocopy: true, subpath },
  });
  config.services.gateway.ports = [];
  config.services.gateway.volumes = [
    mount("original/data/gateway", "/data"),
    mount("original/secrets/gateway", "/run/secrets/gateway", true),
    mount("original/secrets/shared", "/run/secrets/shared", true),
    mount("fixture", "/fixture", true),
  ];
  config.services.runner.volumes = [
    mount("original/data/runner", "/data"),
    mount("original/workspaces", "/workspaces"),
    mount("original/home/runner", "/home/agentdesk"),
    mount("original/secrets/runner", "/run/secrets/runner", true),
    mount("original/secrets/shared", "/run/secrets/shared", true),
  ];
  for (const service of Object.values(config.services)) delete service.env_file;
  config.services.fixture = {
    healthcheck: {
      test: [
        "CMD",
        "node",
        "-e",
        "const s=require('net').connect(8443,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))",
      ],
      interval: "2s",
      timeout: "2s",
      retries: 10,
    },
    image: "agentdesk-runner:local-validation",
    init: true,
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    entrypoint: ["node", "/fixture/fixture.mjs"],
    volumes: [mount("fixture", "/fixture", true)],
    networks: { agentdesk: { ipv4_address: "172.29.197.10" } },
  };
  compose = join(temporary, "compose.json");
  await writeFile(compose, JSON.stringify(config));
  const command = (args) => docker(["compose", "-p", name, "-f", compose, ...args]);
  await command(["up", "-d", "--wait", "--wait-timeout", "90"]);
  console.info("Compose services healthy with production read-only/non-root/resource limits");
  console.info(
    (await command(["exec", "-T", "gateway", "node", "/fixture/client.mjs", "login"])).trim(),
  );
  await command(["restart", "gateway", "runner"]);
  await command(["up", "-d", "--wait", "--wait-timeout", "90"]);
  console.info(
    (await command(["exec", "-T", "gateway", "node", "/fixture/client.mjs", "restart"])).trim(),
  );
  await command(["stop", "gateway", "runner"]);
  console.info(
    (
      await run([
        "--network",
        "none",
        "--entrypoint",
        "python3",
        "agentdesk-cloud-check:local",
        "/checks/tests/backup-restore.py",
      ])
    ).trim(),
  );
  await command(["down"]);
  for (const service of [config.services.gateway, config.services.runner])
    for (const item of service.volumes)
      item.volume.subpath = item.volume.subpath.replace(/^original\//, "restored/");
  await writeFile(compose, JSON.stringify(config));
  await command(["up", "-d", "--wait", "--wait-timeout", "90"]);
  console.info(
    (await command(["exec", "-T", "gateway", "node", "/fixture/client.mjs", "restored"])).trim(),
  );
  console.info("Compose integration and encrypted restore passed");
  const verifyCredential =
    "const a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),DB=require('better-sqlite3');const db=new DB('/data/agentdesk.db',{readonly:true});const row=db.prepare(\"SELECT ciphertext FROM secrets WHERE id LIKE 'cloud-git:%'\").get();a.ok(row);const b=Buffer.from(row.ciphertext,'base64'),key=Buffer.from(fs.readFileSync('/run/secrets/runner/master','utf8').trim(),'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));const value=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());a.equal(value.token,'fixture-git-token');db.close();console.info('Restored Git credential decrypted successfully')";
  console.info((await command(["exec", "-T", "runner", "node", "-e", verifyCredential])).trim());
} catch (error) {
  if (compose)
    console.error(
      await docker(["compose", "-p", name, "-f", compose, "logs", "--tail", "20"]).catch(
        () => "Logs unavailable",
      ),
    );
  throw error;
} finally {
  if (compose)
    await docker(["compose", "-p", name, "-f", compose, "down", "--remove-orphans"]).catch(
      (error) => console.error(error.message),
    );
  if (created) await docker(["volume", "rm", volume]);
  await rm(temporary, { recursive: true, force: true });
}
