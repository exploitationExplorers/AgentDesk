import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { openDatabase, type DbHandle } from "../src/db/client";
import { TeamService } from "../src/services/team";
import { createTeamApp } from "../src/team-app";
import type { TeamSession, TeamTask, TeamClaim, TeamDetail, TeamMessage } from "@agentdesk/shared";
import { Collection } from "../src/db/collection";
import { randomUUID } from "node:crypto";

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

it("执行记录按房间与租约授权，去重、脱敏、分页、限量并保留重试历史", async () => {
  const { root, human, friend, bot } = await fixture();
  const work = await task(root, friend.member.id);
  await service.control(human, work.id, { action: "accept" });
  const claim = (await service.claim(bot))!;
  const secret = "sk-" + "t".repeat(32);
  const entry = { id: randomUUID(), kind: "output", text: "API_KEY=" + secret };
  await expect(
    service.appendExecution(human, work.id, { lease: claim.lease, entries: [entry] }),
  ).rejects.toThrow("租约");
  await service.appendExecution(bot, work.id, { lease: claim.lease, entries: [entry] });
  await service.appendExecution(bot, work.id, { lease: claim.lease, entries: [entry] });
  const first = await service.executionPage(root, work.id);
  expect(first.entries).toHaveLength(1);
  expect(first.entries[0]?.text).not.toContain(secret);
  const foreign = await actor(await service.create(project));
  await expect(service.executionPage(foreign, work.id)).rejects.toThrow("不存在");
  for (let i = 0; i < 16; i++)
    await service.appendExecution(bot, work.id, {
      lease: claim.lease,
      entries: Array.from({ length: 16 }, (_, j) => ({
        id: randomUUID(),
        kind: "stage",
        text: `步骤 ${i}-${j}`,
      })),
    });
  const bounded = await service.executionPage(human, work.id);
  expect(bounded.truncated).toBe(true);
  expect(bounded.entries).toHaveLength(100);
  expect((await service.executionPage(human, work.id, bounded.cursor)).entries[0]?.seq).toBe(
    bounded.cursor + 1,
  );
  await service.control(root, work.id, { action: "stop" });
  await expect(
    service.appendExecution(bot, work.id, {
      lease: claim.lease,
      entries: [{ ...entry, id: randomUUID() }],
    }),
  ).rejects.toThrow("租约");
  await service.control(human, work.id, { action: "retry" });
  const retry = (await service.claim(bot))!;
  await service.appendExecution(bot, work.id, {
    lease: retry.lease,
    entries: [{ id: randomUUID(), kind: "stage", text: "重新执行" }],
  });
  const stored = new Collection<{ id: string; entries: unknown[] }>(db.db, "team_execution").get(
    work.id,
  )!;
  expect(stored.entries).toHaveLength(240);
  expect(JSON.stringify((await service.executionPage(root, work.id, 257)).entries)).toContain(
    '"attempt":2',
  );
});

it("网页领取只允许执行成员本人，配对不假装执行器在线，停止后旧租约不能交付", async () => {
  const { root, human, friend, bot } = await fixture();
  const work = await task(root, friend.member.id);
  expect((await service.detail(human)).me.workerSeenAt).toBeUndefined();
  expect(await service.claim(bot)).toBeNull();
  expect((await service.detail(human)).me.workerSeenAt).toBeTruthy();
  await expect(service.control(root, work.id, { action: "accept" })).rejects.toThrow("本人");
  await expect(service.control(bot, work.id, { action: "accept" })).rejects.toThrow("本人");
  const foreign = await service.authenticate((await service.create(project)).token);
  await expect(service.control(foreign, work.id, { action: "accept" })).rejects.toThrow("不存在");
  const results = await Promise.all([
    service.control(human, work.id, { action: "accept" }),
    service.control(human, work.id, { action: "accept" }),
  ]);
  expect(results[0]?.executionRequestedAt).toBeTruthy();
  expect(
    (await service.detail(human)).messages.filter((m) => m.content.includes("领取了任务")),
  ).toHaveLength(1);
  const first = (await service.claim(bot))!;
  await service.control(human, work.id, { action: "stop" });
  await expect(
    service.progress(bot, work.id, { lease: first.lease, progress: "继续执行" }),
  ).rejects.toThrow("租约");
  await expect(service.submit(bot, work.id, { lease: first.lease, delivery })).rejects.toThrow(
    "租约",
  );
  expect(await service.claim(bot)).toBeNull();
  await service.control(human, work.id, { action: "retry" });
  const retry = (await service.claim(bot))!;
  expect(retry.task.attempt).toBe(2);
  expect(retry.task.branch).not.toBe(first.task.branch);
  await service.control(root, work.id, { action: "stop" });
  expect((await service.detail(human)).tasks[0]?.status).toBe("blocked");
  await expect(
    service.review(human, work.id, { action: "approve", note: "自己验收" }),
  ).rejects.toThrow("负责人本人");
});

it("未配对成员不能领取，网页请求不能伪造执行结果，撤回后不再自动接单", async () => {
  const owner = await service.create(project),
    root = await actor(owner);
  const work = await task(root, owner.member.id);
  await expect(service.control(root, work.id, { action: "accept" })).rejects.toThrow("先连接");
  const code = await service.pairCode(root);
  const bot = await actor(await service.pair({ code: code.code, name: "Codex" }));
  await expect(service.control(root, work.id, { action: "accept", delivery })).rejects.toThrow();
  await service.control(root, work.id, { action: "accept" });
  await service.control(root, work.id, { action: "stop" });
  expect(await service.claim(bot)).toBeNull();
  await service.control(root, work.id, { action: "retry" });
  expect((await service.claim(bot))?.task.id).toBe(work.id);
});

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
  expect(await post("/claim", {}, agent.token)).toBeNull();
  await post(`/tasks/${work.id}/control`, { action: "accept" }, friend.token);
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
  await service.control(human, first.id, { action: "accept" });
  const [a, b] = await Promise.all([service.claim(bot), service.claim(bot)]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  await expect(service.claim(human)).rejects.toThrow("已配对 Agent");
  const ownerPair = await service.pairCode(root);
  const ownerAgent = await service.pair({ code: ownerPair.code, name: "owner codex" });
  expect(await service.claim(await actor(ownerAgent))).toBeNull();
  expect((a ?? b)?.task.id).toBe(first.id);
});
it("断线租约过期后不自动重跑，旧进度与旧交付不能污染重试", async () => {
  const { root, friend, bot, human } = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  const work = await task(root, friend.member.id);
  await service.control(human, work.id, { action: "accept" });
  const first = (await service.claim(bot))!;
  vi.setSystemTime(Date.now() + 46_000);
  expect((await service.detail(root)).tasks[0]?.status).toBe("blocked");
  expect(await service.claim(bot)).toBeNull();
  await service.review(root, work.id, { action: "retry", note: "确认本机旧进程已退出，请重试" });
  expect(await service.claim(bot)).toBeNull();
  await service.control(human, work.id, { action: "accept" });
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
  const { root, friend, bot, human } = await fixture();
  const dev = await task(root, friend.member.id);
  const integration = await task(root, friend.member.id, {
    kind: "integrate",
    title: "IM 整体回归",
    dependsOn: [dev.id],
  });
  await service.control(human, dev.id, { action: "accept" });
  await service.control(human, integration.id, { action: "accept" });
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
  await service.control(human, dev.id, { action: "accept" });
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
  const { root, friend, bot, agent, human } = await fixture();
  const work = await task(root, friend.member.id);
  await service.control(human, work.id, { action: "accept" });
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
  const { root, friend, bot, human } = await fixture();
  const work = await task(root, friend.member.id);
  await service.control(human, work.id, { action: "accept" });
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
