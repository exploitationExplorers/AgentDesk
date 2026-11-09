import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { expect, it } from "vitest";
import { DeviceIdentity, devicePairProof, deviceProof, type RemoteScope } from "@agentdesk/shared";
import { DeviceStore } from "../src/devices/store";
import { DeviceRelay, attachDeviceChannel } from "../src/devices/relay";
import { HostRunnerClient } from "../src/devices/client";
import { parseTrustedProxies, type GatewayConfig } from "../src/config";
import { startConnector } from "../../cli/src/connect/channel";
import { signDevice } from "../../cli/src/connect/protocol";
import { createContainer } from "../../sidecar/src/container";
import { createCloudApp } from "../../sidecar/src/cloud-app";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Device channel timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

it("uses the real socket and local runner for selected projects, streams and retries; rejects stale epochs and revoked devices", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-device-test-"));
  const workspace = join(root, "project");
  mkdirSync(workspace);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workspace, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Device Test");
  git("config", "user.email", "device@test.invalid");
  writeFileSync(join(workspace, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-m", "chore: initial");
  const db = new Database(":memory:");
  const config = {
    publicOrigin: "https://agent.example.test",
    remoteToken: randomBytes(32).toString("hex"),
    runnerUrl: "http://127.0.0.1:1",
    trustedProxies: parseTrustedProxies("127.0.0.1/32"),
  } as GatewayConfig;
  const store = new DeviceStore(db, "secret".repeat(8), config.publicOrigin),
    relay = new DeviceRelay(store);
  const actor = { userId: "owner", sessionId: "session", recentAuthAt: new Date().toISOString() };
  const keys = generateKeyPairSync("ed25519");
  const secret = keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const pair = store.createPairing(actor);
  const identity = DeviceIdentity.parse({
    name: "Office",
    platform: "win32",
    instanceId: randomUUID(),
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    projects: [{ id: "pending", name: "project", path: realpathSync(workspace) }],
  });
  // 本机先通过已有实例登记项目，然后才配对该实例的真实 ID。
  const paths: Record<string, string> = {};
  const sidecarConfig = {
    version: "test",
    host: "127.0.0.1",
    port: 0,
    token: "local-token",
    dataDir: join(root, "data"),
    masterKey: randomBytes(32).toString("base64"),
    skillDirs: [],
    wechatReportEnabled: false,
    allowedOrigins: [],
  };
  // 宿主 ID 可在配对之前分配；本测试将完成配对后创建唯一的本地容器。
  const claim = store.claim(
    pair.code,
    identity,
    signDevice(secret, devicePairProof(config.publicOrigin, pair.code, identity)),
  );
  const container = await createContainer(sidecarConfig, {
    inMemory: true,
    office: { hostId: claim.hostId, projects: paths, taskTimeoutMs: 60_000 },
  });
  const project = await container.projects.add(workspace);
  paths[project.id] = realpathSync(workspace);
  identity.projects[0]!.id = project.id;
  // 测试夹具对齐本机生成的随机项目 ID，不绕过生产命令的 allowlist 校验。
  db.prepare("UPDATE devices SET identity=? WHERE id=?").run(
    JSON.stringify(identity),
    claim.hostId,
  );
  store.confirmPairing(actor, pair.id, claim.fingerprint, [project.id]);
  store.localConfirm(claim.hostId);
  const credentials = {
    schemaVersion: 1 as const,
    server: config.publicOrigin,
    hostId: claim.hostId,
    userId: actor.userId,
    identity,
    projects: [project.id],
    privateKey: secret,
    enabled: true,
  };
  const local = createCloudApp(container, {
    ...sidecarConfig,
    kind: "office",
    hostId: claim.hostId,
    name: "Office",
    workspaceRoot: root,
    remoteToken: config.remoteToken,
    ownerUserId: actor.userId,
    allowedProviderHosts: [],
    taskTimeoutMs: 60_000,
  });
  const server = createServer((_req, res) => res.end());
  const closeChannel = attachDeviceChannel(server, config, relay);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  let connector: ReturnType<typeof startConnector> | undefined;
  const connect = () =>
    startConnector(
      credentials,
      (req) => local.fetch(req),
      (req) => {
        const request = new Request(req);
        request.headers.set("x-agentdesk-remote-token", config.remoteToken);
        return request;
      },
      {
        authorize: async () => {
          const challenge = store.challenge(claim.hostId, "connect");
          store.authenticate(
            challenge.id,
            signDevice(
              secret,
              deviceProof(config.publicOrigin, claim.hostId, "connect", challenge.nonce),
            ),
          );
          return store.token(claim.hostId);
        },
        open: (token) =>
          new WebSocket(`ws://127.0.0.1:${port}/device-channel`, ["agentdesk-v1", token], {
            headers: { host: "agent.example.test", "x-forwarded-proto": "https" },
          }) as unknown as globalThis.WebSocket,
      },
    );
  try {
    connector = connect();
    await until(() => connector!.status().state === "online");
    const client = new HostRunnerClient(config, relay),
      office = client.forHost(claim.hostId);
    const projects = await office.json<{ projects: { id: string }[] }>("/host/projects");
    expect(projects.projects.map((p) => p.id)).toEqual([project.id]);
    expect((await office.json("/health")).mode).toBe("office");
    const scope: RemoteScope = {
      userId: actor.userId,
      hostId: claim.hostId,
      projectId: project.id,
      workspaceId: project.id,
    };
    const status = await client.execute(scope, actor, "project.read", { kind: "status" });
    expect(status).toBeTruthy();
    const taskInput = {
      clientRequestId: randomUUID(),
      goal: "Check the project",
      executor: "native-bot",
      workspaceMode: "existing",
      workspaceId: project.id,
      requiresPlanApproval: true,
    };
    const created = await client.execute<{ task: { id: string } }>(
      scope,
      actor,
      "task.create",
      taskInput,
      taskInput.clientRequestId,
    );
    const replayed = await client.execute<{ task: { id: string } }>(
      scope,
      actor,
      "task.create",
      taskInput,
      taskInput.clientRequestId,
    );
    expect(replayed.task.id).toBe(created.task.id);
    const streamPayload = { taskId: created.task.id, after: 0 };
    const response = await office.request(
      `/tasks/${created.task.id}/events`,
      { command: client.command(scope, actor, "task.read", streamPayload), payload: streamPayload },
      { stream: true },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toMatch(/data:|event:|:/);
    await reader.cancel();
    // 非白名单请求在网关处被拒绝，不会抵达本机完整 API。
    await expect(office.json("/api/cli/shutdown", {})).rejects.toThrow();
    const oldCommand = client.command(scope, actor, "project.read", { kind: "status" });
    const epoch = relay.epoch(claim.hostId);
    await expect(
      client.execute(
        { ...scope, projectId: "foreign", workspaceId: "foreign" },
        actor,
        "project.read",
        { kind: "status" },
      ),
    ).rejects.toThrow();
    connector.stop();
    await until(() => !relay.online(claim.hostId));
    await expect(
      client.execute(scope, actor, "project.read", { kind: "status" }),
    ).rejects.toThrow();
    connector = connect();
    await until(() => connector!.status().state === "online");
    expect(relay.epoch(claim.hostId)).toBeGreaterThan(epoch);
    await expect(
      office.json("/commands", { command: oldCommand, payload: { kind: "status" } }),
    ).rejects.toThrow();
    store.revoke(claim.hostId, actor);
    relay.disconnect(claim.hostId);
    await expect(
      client.execute(scope, actor, "project.read", { kind: "status" }),
    ).rejects.toThrow();
  } finally {
    connector?.stop();
    closeChannel();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await container.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
