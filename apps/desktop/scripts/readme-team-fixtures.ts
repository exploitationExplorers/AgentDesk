import {
  CollaborationRoomDetail,
  TeamDetail,
  TeamSession,
  TeamExecutionPage,
} from "@agentdesk/shared";

// 公开文档专用固定数据，与生产项目、成员和登录态无关。
export const teamDemoTime = "2026-11-14T08:30:00.000Z";
const members = [
  {
    id: "demo-owner",
    name: "项目负责人",
    role: "owner",
    executor: "Codex CLI",
    workerSeenAt: teamDemoTime,
  },
  { id: "demo-ios", name: "iOS 开发", role: "member", executor: "Claude Code" },
  {
    id: "demo-api",
    name: "接口开发",
    role: "member",
    executor: "自定义 Agent",
    workerSeenAt: teamDemoTime,
  },
].map((member) => ({ ...member, roomId: "demo-team", revoked: false, connectedAt: teamDemoTime }));
const room = {
  id: "demo-team",
  name: "IM 原生应用协作",
  ownerId: "demo-owner",
  goal: "对齐接口与原生端架构，分工实现，再汇总回归。",
  repository: "https://github.com/example/im-demo.git",
  baseRevision: "a".repeat(40),
  createdAt: teamDemoTime,
};
const task = {
  roomId: room.id,
  instructions: "核对原生端职责划分，整理模块边界、命名约定和接口验收清单。",
  assigneeId: "demo-owner",
  kind: "develop",
  dependsOn: [],
  acceptance: ["文档对应实际模块", "说明检查范围与待确认事项"],
  baseRevision: room.baseRevision,
  attempt: 0,
  createdAt: teamDemoTime,
  updatedAt: teamDemoTime,
};
export const teamDemo = TeamDetail.parse({
  room,
  me: members[0],
  members,
  messages: [
    {
      authorId: "demo-owner",
      authorKind: "human",
      content: "先确认登录与消息接口，再分别开发原生端和服务端。@iOS 开发 请核对错误码与重连行为。",
      mentionIds: ["demo-ios"],
    },
    {
      authorId: "demo-ios",
      authorKind: "human",
      content: "建议沿用统一错误码，断线重连与消息去重分别验收。",
      replyToId: "demo-message-1",
    },
    {
      authorId: "demo-api",
      authorKind: "agent",
      content: "已核对接口契约：登录返回会话标识，消息以客户端唯一 ID 去重。待负责人确认后开发。",
      replyToId: "demo-message-2",
    },
    {
      authorId: "demo-owner",
      authorKind: "system",
      content: "已分配任务：整理原生端架构规范。功能验收后再安排集成回归。",
    },
  ].map((message, i) => ({
    ...message,
    id: `demo-message-${i + 1}`,
    roomId: room.id,
    seq: i + 1,
    mentionIds: message.mentionIds ?? [],
    createdAt: teamDemoTime,
  })),
  tasks: [
    {
      ...task,
      id: "11111111-1111-4111-8111-111111111111",
      branch: "agentdesk/11111111-1111-4111-8111-111111111111-1",
      title: "整理原生端架构规范",
      status: "queued",
      progress: "等待执行成员在网页领取任务",
    },
    {
      ...task,
      id: "22222222-2222-4222-8222-222222222222",
      branch: "agentdesk/22222222-2222-4222-8222-222222222222-1",
      title: "登录接口与错误码契约",
      status: "submitted",
      attempt: 1,
      assigneeId: "demo-api",
      progress: "已交付，等待负责人验收",
      delivery: {
        revision: "b".repeat(40),
        summary: "已完成登录接口和错误码约定，包含成功、未授权与失效会话检查。",
        checks: [{ name: "登录接口回归", exitCode: 0 }],
      },
    },
  ],
});
export const teamDemoSession = TeamSession.parse({
  room,
  member: members[0],
  token: "demo-session",
});
const modelSelection = { providerId: "readme-demo-provider", model: "demo-model" };
const discussionMembers = [
  { id: "demo-research", name: "方案调研", agent: "research" },
  { id: "demo-verify", name: "接口核验", agent: "code" },
  { id: "demo-summary", name: "结论整理", agent: "orchestrator" },
].map((member) => ({ ...member, modelSelection, available: true, createdAt: teamDemoTime }));
export const discussionDemo = CollaborationRoomDetail.parse({
  room: {
    id: "demo-discussion",
    name: "IM 架构讨论",
    topic: "原生端重构如何划分模块和验收范围？",
    participants: discussionMembers.map((member, i) => ({
      memberId: member.id,
      role: ["research", "verify", "summarize"][i],
    })),
    status: "awaiting_decision",
    round: 1,
    maxRounds: 2,
    createdAt: teamDemoTime,
    updatedAt: teamDemoTime,
  },
  members: discussionMembers,
  messages: [
    {
      author: { kind: "owner", id: "owner", name: "你" },
      content: "请从模块边界、接口兼容和回归范围三个角度评估原生端重构。",
    },
    {
      author: {
        kind: "agent",
        id: "demo-research",
        name: "方案调研",
        agent: "research",
        modelSelection,
      },
      role: "research",
      content: "建议分为会话、联系人、消息与基础设施四层；先保持登录和消息协议兼容。",
    },
    {
      author: { kind: "agent", id: "demo-verify", name: "接口核验", agent: "code", modelSelection },
      role: "verify",
      replyToId: "discussion-message-2",
      content: "需要补充错误码、断线重连和重复消息处理的契约测试，避免只检查页面是否能打开。",
    },
    {
      author: {
        kind: "agent",
        id: "demo-summary",
        name: "结论整理",
        agent: "orchestrator",
        modelSelection,
      },
      role: "summarize",
      content:
        "建议先冻结接口契约，再并行开发各模块；每项交付独立验收，最后运行集成回归。请确认是否采用。",
    },
  ].map((message, i) => ({
    ...message,
    id: `discussion-message-${i + 1}`,
    roomId: "demo-discussion",
    seq: i + 1,
    round: 1,
    status: "complete",
    mentionIds: [],
    evidence: [],
    toolCalls: [],
    createdAt: teamDemoTime,
  })),
  pendingApprovals: [],
});

export const teamExecutionDemo = TeamDetail.parse({
  ...teamDemo,
  tasks: [
    { ...teamDemo.tasks[0], status: "running", attempt: 1, progress: "正在核对接口契约并运行检查" },
  ],
});
export const teamExecutionDemoPage = TeamExecutionPage.parse({
  cursor: 4,
  truncated: false,
  entries: [
    { kind: "stage", text: "本机已确认任务，进入独立 worktree" },
    { kind: "command", text: "git diff --stat" },
    { kind: "files", text: "src/auth/session.ts\ntest/auth/session.test.ts" },
    { kind: "check", text: "登录会话回归：退出码 0（演示数据）" },
  ].map((entry, i) => ({
    ...entry,
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    seq: i + 1,
    attempt: 1,
    createdAt: teamDemoTime,
  })),
});
