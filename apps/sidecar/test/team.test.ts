import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { TeamService } from "../src/services/team";
import { createTeamApp } from "../src/team-app";
import type { TeamSession, TeamTask, TeamClaim, TeamDetail, TeamMessage } from "@agentdesk/shared";
import { Collection } from "../src/db/collection";

let db: DbHandle, service: TeamService;
const base = "a".repeat(40),
  revision = "b".repeat(40),
  admin = "test-admin-" + "x".repeat(40);
const project = {
  name: "IM 项目",
  ownerName: "负责人",
  goal: "共同开发 IM",
  repository: "https://github.com/team/im.git",
  baseRevision: base,
};
beforeEach(() => {
  db = openDatabase(":memory:");
  service = new TeamService(db.db);
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});
const actor = (session: TeamSession) => service.authenticate(session.token);
async function fixture() {
  const owner = await service.create(project),
    root = await actor(owner);
  const ticket = await service.invite(root);
  const friend = await service.join({ code: ticket.code, name: "朋友" });
  const human = await actor(friend);
  const pair = await service.pairCode(human);
  const agent = await service.pair({ code: pair.code, name: "Claude Code" });
  return { owner, root, friend, human, agent, bot: await actor(agent) };
}
async function task(root: Awaited<ReturnType<typeof actor>>, member: string, extra = {}) {
  return service.createTask(root, {
    title: "账号系统",
    instructions: "实现登录接口并增加测试",
    assigneeId: member,
    acceptance: ["接口测试通过"],
    ...extra,
  });
}
const delivery = { revision, summary: "已实现接口", checks: [{ name: "API 单测", exitCode: 0 }] };

it("真实 HTTP 完成邀请、配对、任务、进度、交付与负责人验收", async () => {
  const app = createTeamApp(service, { adminKey: admin });
  async function post<T>(path: string, body: unknown, token?: string) {
    const res = await app.request(`/team-api/v1${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    return (await res.json()) as T;
  }
  const owner = await post<TeamSession>("/create", project, admin);
  const invite = await post<{ code: string }>("/invites", {}, owner.token);
  const friend = await post<TeamSession>("/join", { code: invite.code, name: "Codex 成员" });
  const pair = await post<{ code: string }>("/pairing-code", {}, friend.token);
  const agent = await post<TeamSession>("/pair", { code: pair.code, name: "Codex" });
  const work = await post<TeamTask>(
    "/tasks",
    {
      title: "登录功能",
      instructions: "实现登录",
      assigneeId: friend.member.id,
      acceptance: ["单测通过"],
    },
    owner.token,
  );
  const claim = await post<TeamClaim>("/claim", {}, agent.token);
  expect(claim.task.id).toBe(work.id);
  await post(
    `/tasks/${work.id}/progress`,
    { lease: claim.lease, progress: "正在开发登录接口" },
    agent.token,
  );
  await post(`/tasks/${work.id}/submit`, { lease: claim.lease, delivery }, agent.token);
  await post(
    `/tasks/${work.id}/review`,
    { action: "approve", note: "已复核接口和测试结果" },
    owner.token,
  );
  const response = await app.request("/team-api/v1/room", {
    headers: { Authorization: `Bearer ${friend.token}` },
  });
  const detail = (await response.json()) as TeamDetail;
  expect(detail.tasks[0]?.status).toBe("approved");
  expect(JSON.stringify(detail)).not.toContain(claim.lease);
  expect(JSON.stringify(detail)).not.toContain(owner.token);
  expect(JSON.stringify(detail)).not.toContain("leaseHash");
  for (const path of [
    "/api/providers",
    "/api/projects",
    "/api/approvals",
    "/remote-api/v1",
    "/team-api/v1/admin",
  ]) {
    expect((await app.request(path)).status).toBeGreaterThanOrEqual(400);
  }
});
it("单次邀请并发只允许一位成员加入，配对凭证不能代替人的身份", async () => {
  const owner = await service.create(project),
    root = await actor(owner);
  const invite = await service.invite(root);
  const results = await Promise.allSettled([
    service.join({ code: invite.code, name: "A" }),
    service.join({ code: invite.code, name: "B" }),
  ]);
  expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
  const { bot } = await fixture();
  await expect(service.invite(bot)).rejects.toThrow("负责人本人");
  await expect(service.pairCode(bot)).rejects.toThrow("本人配对");
  await expect(service.review(bot, "any", { action: "approve", note: "已授权" })).rejects.toThrow(
    "负责人本人",
  );
});
it("人和 Agent 的身份由凭证确定，防止伪造作者与跨项目引用/点名", async () => {
  const { root, bot, friend } = await fixture();
  const foreign = await service.create(project),
    other = await actor(foreign);
  const msg = await service.message(other, { requestId: "foreign", content: "外部消息" });
  await expect(
    service.message(bot, { requestId: "fake", content: "我代表负责人", authorKind: "human" }),
  ).rejects.toThrow();
  await expect(
    service.message(root, { requestId: "reply", content: "引用", replyToId: msg.id }),
  ).rejects.toThrow("引用不属于");
  await expect(
    service.message(root, {
      requestId: "mention",
      content: "点名",
      mentionIds: [foreign.member.id],
    }),
  ).rejects.toThrow("点名成员");
  const reply = await service.message(bot, { requestId: "own", content: "请讨论接口" });
  expect(reply.authorId).toBe(friend.member.id);
  expect(reply.authorKind).toBe("agent");
});
it("并发冻结时钟消息严格排序、发送幂等，重复 ID 不可换内容", async () => {
  const { root } = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      service.message(root, { requestId: `${i}`, content: `内容${i}` }),
    ),
  );
  await service.message(root, { requestId: "0", content: "内容0" });
  await expect(service.message(root, { requestId: "0", content: "替换" })).rejects.toThrow(
    "请求 ID",
  );
  const detail = await service.detail(root);
  expect(detail.messages.map((message) => message.seq)).toEqual(
    Array.from({ length: detail.messages.length }, (_, i) => i + 1),
  );
});
it("只领取自己的任务且并发不重复派发；租约从不出现在群详情", async () => {
  const { root, friend, bot, human } = await fixture();
  const first = await task(root, friend.member.id);
  const [a, b] = await Promise.all([service.claim(bot), service.claim(bot)]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  await expect(service.claim(human)).rejects.toThrow("已配对 Agent");
  const ownerPair = await service.pairCode(root);
  const ownerAgent = await service.pair({ code: ownerPair.code, name: "owner codex" });
  expect(await service.claim(await actor(ownerAgent))).toBeNull();
  expect((a ?? b)?.task.id).toBe(first.id);
});
it("断线租约过期后不自动重跑，旧进度与旧交付不能污染重试", async () => {
  const { root, friend, bot } = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  const work = await task(root, friend.member.id),
    first = (await service.claim(bot))!;
  vi.setSystemTime(Date.now() + 46_000);
  expect((await service.detail(root)).tasks[0]?.status).toBe("blocked");
  expect(await service.claim(bot)).toBeNull();
  await service.review(root, work.id, { action: "retry", note: "确认本机旧进程已退出，请重试" });
  const retry = (await service.claim(bot))!;
  expect(retry.task.attempt).toBe(2);
  expect(retry.task.branch).not.toBe(first.task.branch);
  await expect(
    service.progress(bot, work.id, { lease: first.lease, progress: "旧回报" }),
  ).rejects.toThrow("租约");
  await expect(service.submit(bot, work.id, { lease: first.lease, delivery })).rejects.toThrow(
    "租约",
  );
  await service.submit(bot, work.id, { lease: retry.lease, delivery });
});
it("撤销/重新配对立即使旧凭证失效，已经认证的在途请求也不能再领取", async () => {
  const { root, friend, human, bot, agent } = await fixture();
  await task(root, friend.member.id);
  const code = await service.pairCode(human);
  await service.pair({ code: code.code, name: "新 Agent" });
  await expect(service.authenticate(agent.token)).rejects.toThrow("失效");
  await expect(service.claim(bot)).rejects.toThrow("撤销或过期");
  await service.revoke(root, friend.member.id);
  await expect(service.authenticate(friend.token)).rejects.toThrow();
  await expect(service.pair({ code: code.code, name: "再用" })).rejects.toThrow();
});
it("失败检查不能验收，Agent 不能拍板；集成等所有依赖通过后才领取", async () => {
  const { root, friend, bot } = await fixture();
  const dev = await task(root, friend.member.id);
  const integration = await task(root, friend.member.id, {
    kind: "integrate",
    title: "IM 整体回归",
    dependsOn: [dev.id],
  });
  const claim = (await service.claim(bot))!;
  await service.submit(bot, dev.id, {
    lease: claim.lease,
    delivery: { ...delivery, checks: [{ name: "单测", exitCode: 1 }] },
  });
  await expect(
    service.review(root, dev.id, { action: "approve", note: "忽略失败" }),
  ).rejects.toThrow("测试通过");
  expect(await service.claim(bot)).toBeNull();
  await service.review(root, dev.id, { action: "revise", note: "修正失败测试" });
  const retry = (await service.claim(bot))!;
  await service.submit(bot, dev.id, { lease: retry.lease, delivery });
  await service.review(root, dev.id, { action: "approve", note: "已复核" });
  const aggregate = (await service.claim(bot))!;
  expect(aggregate.task.id).toBe(integration.id);
  expect(aggregate.dependencies[0]?.delivery?.revision).toBe(revision);
  await expect(
    service.review(root, dev.id, { action: "revise", note: "修改已验收版本" }),
  ).rejects.toThrow("已结束");
});
it("持久化中只保存凭证摘要；重建服务不重放正在执行的任务", async () => {
  const { root, friend, bot, agent } = await fixture();
  await task(root, friend.member.id);
  const claim = await service.claim(bot);
  const stored = new Collection<{ id: string }>(db.db, "team_credentials").list();
  expect(JSON.stringify(stored)).not.toContain(agent.token);
  const restored = new TeamService(db.db);
  expect(await restored.claim(await restored.authenticate(agent.token))).toBeNull();
  expect((await restored.detail(root)).tasks[0]?.status).toBe("running");
  expect(claim).not.toBeNull();
});
it("邀请和配对过期、无密钥创建、跨站请求和未知字段均拒绝", async () => {
  const { root } = await fixture();
  const invite = await service.invite(root),
    pair = await service.pairCode(root);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 86400_001);
  await expect(service.join({ code: invite.code, name: "迟到" })).rejects.toThrow("过期");
  await expect(service.pair({ code: pair.code, name: "迟到" })).rejects.toThrow("过期");
  const app = createTeamApp(service, { adminKey: admin });
  expect(
    (
      await app.request("/team-api/v1/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request("/team-api/v1/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          Authorization: `Bearer ${admin}`,
        },
        body: JSON.stringify(project),
      })
    ).status,
  ).toBe(403);
  await expect(service.create({ ...project, apiKey: "not-accepted" })).rejects.toThrow();
  await expect(
    service.create({ ...project, repository: "https://user:secret@github.com/team/im.git" }),
  ).rejects.toThrow();
});

it("宝塔 HTTPS 反代使用固定公开域名，撤销未使用邀请后不能加入", async () => {
  const { root } = await fixture();
  const invite = await service.invite(root);
  await service.revokeInvites(root);
  await expect(service.join({ code: invite.code, name: "已撤销" })).rejects.toThrow();
  const app = createTeamApp(service, { adminKey: admin, publicOrigin: "https://team.example.com" });
  const response = await app.request("http://team.example.com/team-api/v1/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://team.example.com",
      Authorization: `Bearer ${admin}`,
    },
    body: JSON.stringify(project),
  });
  expect(response.status).toBe(201);
});

it("群消息达到上限时仍能撤销连接并阻塞在途任务", async () => {
  const { root, friend, bot } = await fixture();
  await task(root, friend.member.id);
  await service.claim(bot);
  const records = new Collection<{ id: string; messages: TeamMessage[] }>(db.db, "team_rooms");
  const record = records.get(root.roomId)!;
  const first = record.messages[0]!;
  record.messages = Array.from({ length: 2000 }, (_, index) => ({
    ...first,
    id: `history-${index}`,
    seq: index + 1,
  }));
  records.put(record);
  await expect(service.message(root, { requestId: "full", content: "超额消息" })).rejects.toThrow(
    "上限",
  );
  await service.revoke(root, friend.member.id, true);
  await expect(service.detail(bot)).rejects.toThrow("撤销");
  const detail = await service.detail(root);
  expect(detail.tasks[0]?.status).toBe("blocked");
  expect(detail.messages.at(-1)?.seq).toBe(2001);
  expect(detail.messages.at(-1)?.content).toContain("已撤销");
});
