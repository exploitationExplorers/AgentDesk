import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { TeamClaim, type TeamSession, type TeamDetail } from "@agentdesk/shared";
import type { CliValues } from "../args.js";
import { question } from "../terminal.js";
import { readTeamConnection, saveTeamConnection, teamOrigin, teamRequest } from "./client.js";
import { executeTeamTask, localTeamConfig } from "./runner.js";

export async function teamCommand(
  home: string,
  action: string,
  words: string[],
  values: CliValues,
) {
  if (action === "pair") {
    const server = teamOrigin(values.server ?? (await question("团队 HTTPS 地址")));
    const code = await question("网页中「连接我的 Agent」的单次配对码", { secret: true });
    const name = await question("Agent 名称，例如 Claude Code / Codex");
    const session = await teamRequest<TeamSession>(server, undefined, "/pair", { code, name });
    saveTeamConnection(home, {
      server,
      token: session.token,
      roomId: session.room.id,
      memberId: session.member.id,
    });
    console.info(`已连接 ${session.room.name}。模型凭据留在本机；下一步运行 team work。`);
    return;
  }
  const connection = readTeamConnection(home);
  const request = <T>(path: string, data?: unknown) =>
    teamRequest<T>(connection.server, connection.token, path, data);
  if (action === "read") {
    const detail = await request<TeamDetail>("/room");
    console.info(JSON.stringify(detail, null, 2));
    return;
  }
  if (action === "say") {
    const content = words.join(" ").trim() || (await question("发送到项目群的消息"));
    await request("/messages", { requestId: randomUUID(), content });
    console.info("群消息已发送。");
    return;
  }
  if (!values.repo || !values["runner-config"])
    throw new Error("team work 需要 --repo 仓库根目录 --runner-config 本机检查配置.json");
  const config = localTeamConfig(values["runner-config"]);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.info("等待分配任务。每项任务需要本机确认；Ctrl+C 停止连接。断线或撤权会停止执行。");
  try {
    while (!shutdown.signal.aborted) {
      const raw = await request<unknown>("/claim", {});
      const claim = raw === null ? null : TeamClaim.parse(raw);
      if (!claim) {
        if (values.once) return;
        await delay(3000, undefined, { signal: shutdown.signal });
        continue;
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([
        shutdown.signal,
        controller.signal,
        AbortSignal.timeout(3600_000),
      ]);
      let progress = "等待本机成员确认执行",
        sending = false;
      const heartbeat = async () => {
        if (sending || signal.aborted) return;
        sending = true;
        try {
          await request(`/tasks/${claim.task.id}/progress`, { lease: claim.lease, progress });
        } catch {
          controller.abort();
        } finally {
          sending = false;
        }
      };
      const timer = setInterval(() => void heartbeat(), 10_000);
      try {
        const context = await request<TeamDetail>("/room");
        const delivery = await executeTeamTask({
          claim,
          repo: values.repo,
          config,
          signal,
          discussion: context.messages.slice(-30).map((message) => ({
            author:
              context.members.find((member) => member.id === message.authorId)?.name ?? "项目动态",
            kind: message.authorKind,
            content: message.content.slice(0, 2000),
          })),
          confirm: async (message) => (await question(`${message} 输入 yes`)) === "yes",
          summarize: () => question("交付摘要（将分享给项目群，请勿包含密钥）"),
          progress: (value) => {
            progress = value;
            console.info(value);
            void heartbeat();
          },
        });
        clearInterval(timer);
        signal.throwIfAborted();
        await request(`/tasks/${claim.task.id}/submit`, { lease: claim.lease, delivery });
        console.info("已提交交付，等待负责人验收。");
      } catch (error) {
        clearInterval(timer);
        console.error(error instanceof Error ? error.message : "本机执行未完成");
        console.error("本次任务未交付。请检查本机终端和任务 worktree，负责人明确重试前不会重跑。");
        await request(`/tasks/${claim.task.id}/block`, {
          lease: claim.lease,
          progress: "本机执行未完成，请与成员核对后明确重试",
        }).catch(() => undefined);
      } finally {
        clearInterval(timer);
      }
      if (values.once || shutdown.signal.aborted) return;
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
