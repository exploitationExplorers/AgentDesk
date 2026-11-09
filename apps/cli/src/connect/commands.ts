import { generateKeyPairSync, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DeviceIdentity, devicePairProof } from "@agentdesk/shared";
import type { CliValues } from "../args.js";
import { apiRequest } from "../client.js";
import { runningState, serviceStatus, startService, stopService } from "../lifecycle.js";
import { question } from "../terminal.js";
import {
  readConnector,
  serverOrigin,
  writeConnector,
  type ConnectorCredentials,
} from "./credentials.js";
import { devicePost, proveDevice, signDevice } from "./protocol.js";
import {
  installConnectorAutostart,
  uninstallConnectorAutostart,
  monitorConnector,
} from "./autostart.js";

async function restartConnector(home: string, workerPath: string) {
  const current = await serviceStatus(home);
  if (current.status === "running") {
    const tasks = await (
      await apiRequest<Array<{ status: string }>>(current.state, "/tasks")
    ).json();
    if (
      tasks.some(
        (t) => !["succeeded", "failed", "cancelled", "completed", "closed"].includes(t.status),
      )
    )
      throw new Error(
        "配对已保存。当前实例有未结束任务，请结束后执行 agentdesk connect start，避免重启打断工作。",
      );
    await stopService(home);
  }
  return startService(home, { workerPath, port: current.state?.port });
}
export async function connectCommand(
  home: string,
  workerPath: string,
  action: string,
  values: CliValues,
) {
  const saved = readConnector(home);
  if (action === "install") {
    installConnectorAutostart(home, workerPath);
    console.info("已安装当前 Windows 用户登录自启动与连接进程恢复。电脑睡眠或关机时无法连接。");
    return;
  }
  if (action === "uninstall") {
    uninstallConnectorAutostart(home);
    console.info("已移除登录自启动。现有连接可用 connect revoke 撤销。");
    return;
  }
  if (action === "monitor") {
    await monitorConnector(home, workerPath);
    return;
  }
  if (action === "status") {
    const state = await serviceStatus(home);
    const status =
      state.status === "running"
        ? await (await apiRequest(state.state, "/cli/connect/status")).json()
        : { state: "stopped" };
    console.info(
      JSON.stringify(
        {
          server: saved?.server,
          hostId: saved?.hostId,
          projects: saved?.projects,
          ...(status as object),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === "revoke") {
    if (!saved) throw new Error("此 CLI 实例尚未配对。");
    writeConnector(home, { ...saved, enabled: false });
    const current = await serviceStatus(home);
    if (current.status === "running")
      await apiRequest(current.state, "/cli/connect/stop", { method: "POST", body: "{}" });
    try {
      await proveDevice(saved, "revoke");
      console.info("已撤销电脑连接。重新连接需要重新配对。");
    } catch {
      console.info(
        "已在本机断开并禁用连接；服务器暂不可达，请在手机设备页撤销记录。已发授权最长 45 秒后失效。",
      );
    }
    return;
  }
  if (action === "start") {
    if (!saved) throw new Error("请先执行 agentdesk connect pair --server https://你的域名。");
    // 已撤销设备不能靠本机开关恢复，先用设备私钥确认服务器状态。
    const { device } = await proveDevice<{ device: { state: string } }>(saved, "status");
    if (device.state !== "active") throw new Error("设备未完成配对或已撤销，请重新配对。");
    writeConnector(home, { ...saved, enabled: true });
    await restartConnector(home, workerPath);
    console.info("连接器已随本地服务在后台启动。使用 agentdesk connect status 查看连接状态。");
    return;
  }
  if (action !== "pair") throw new Error("connect 支持 pair、start、status、revoke。");
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new Error("配对需要交互终端，配对码不能通过命令行参数传入。");
  if (saved?.enabled)
    throw new Error("此 CLI 实例已有设备绑定，请先执行 agentdesk connect revoke。");
  const server = serverOrigin(values.server ?? (await question("服务器 HTTPS 地址")));
  const state = await runningState(home, workerPath);
  const projects = await (
    await apiRequest<Array<{ id: string; name: string; path: string }>>(state, "/projects")
  ).json();
  if (!projects.length) throw new Error("请先在此 CLI 实例的浏览器工作台添加要授权的项目。");
  projects.forEach((p, i) => console.info(`${i + 1}. ${p.name}  ${p.path}`));
  const selection = await question("选择授权项目编号，用逗号分隔", {
    validate: (value) => (/^\d+(,\s*\d+)*$/.test(value) ? undefined : "请输入项目编号，例如 1,2"),
  });
  const chosen = [...new Set(selection.split(",").map((v) => Number(v.trim()) - 1))].map(
    (i) => projects[i],
  );
  if (chosen.some((p) => !p)) throw new Error("项目编号不存在。");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const identity = DeviceIdentity.parse({
    name: hostname(),
    platform: process.platform,
    instanceId: saved?.identity.instanceId ?? randomUUID(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    projects: chosen.map((p) => ({ id: p!.id, name: p!.name, path: realpathSync(p!.path) })),
  });
  console.info(`服务器：${server}\n本地数据：${home}\n设备：${identity.name}`);
  for (const p of identity.projects) console.info(`授权项目：${p.name}  ${p.path}`);
  if ((await question("确认允许手机在以上项目中发任务、审批和执行 Git 操作？输入 yes")) !== "yes")
    throw new Error("已取消配对。");
  const code = await question("输入手机显示的一次性配对码", { secret: true });
  const claim = await devicePost<{ hostId: string; fingerprint: string; expiresAt: string }>(
    server,
    "/pair",
    {
      code,
      identity,
      signature: signDevice(secret, devicePairProof(server, code, identity)),
    },
  );
  console.info(
    `设备指纹：${claim.fingerprint}\n请在手机核对设备、指纹和项目后确认，配对码 5 分钟内有效。`,
  );
  let credentials: ConnectorCredentials = {
    schemaVersion: 1,
    server,
    hostId: claim.hostId,
    userId: "pending",
    identity,
    projects: identity.projects.map((p) => p.id),
    privateKey: secret,
    enabled: true,
  };
  while (Date.now() < Date.parse(claim.expiresAt)) {
    const { device } = await proveDevice<{
      device: { state: string; userId: string; projects: string[] };
    }>(credentials, "status");
    if (device.state === "confirmed") {
      const accepted = identity.projects.filter((p) => device.projects.includes(p.id));
      if (accepted.length !== device.projects.length || !accepted.length)
        throw new Error("服务器返回了未选择的项目。");
      console.info(`手机选择：${accepted.map((p) => p.name).join("、")}`);
      if ((await question("在本机完成配对确认？输入 yes")) !== "yes")
        throw new Error("已取消配对。");
      await proveDevice(credentials, "confirm");
      credentials = { ...credentials, userId: device.userId, projects: device.projects };
      writeConnector(home, credentials);
      await restartConnector(home, workerPath);
      console.info("双方确认完成，电脑连接器已启动。");
      return;
    }
    await delay(3000);
  }
  throw new Error("配对已过期，请在手机重新生成配对码。");
}
