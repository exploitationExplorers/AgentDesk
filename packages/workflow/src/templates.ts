import type { WorkflowInput } from "./dsl";

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  build: () => WorkflowInput;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "deploy-pipeline",
    name: "拉代码 → 构建 → 宝塔部署 → 健康检查 → 通知",
    description: "本地确认代码最新后，经人工审批，用浏览器自动化在宝塔上完成部署",
    build: () => ({
      name: "IM 项目一键部署",
      description: "git pull、审批、宝塔部署配方、健康检查、桌面通知",
      trigger: { type: "manual" },
      inputs: [
        { name: "projectId", label: "项目 ID 或路径", default: "" },
        { name: "recipeId", label: "部署配方 ID", default: "" },
        { name: "healthUrl", label: "健康检查 URL", default: "" },
      ],
      nodes: [
        {
          id: "start",
          type: "start",
          position: { x: 0, y: 160 },
          data: { label: "开始", config: {} },
        },
        {
          id: "pull",
          type: "git",
          position: { x: 280, y: 160 },
          data: {
            label: "本地 git pull",
            config: { action: "pull", projectId: "{{inputs.projectId}}" },
          },
        },
        {
          id: "approve",
          type: "approval",
          position: { x: 560, y: 160 },
          data: {
            label: "确认部署",
            config: { title: "确认部署到生产", detail: "本地最新提交：{{nodes.pull.output}}" },
          },
        },
        {
          id: "deploy",
          type: "deploy",
          position: { x: 840, y: 160 },
          data: { label: "宝塔部署", config: { recipeId: "{{inputs.recipeId}}" } },
        },
        {
          id: "health",
          type: "http",
          position: { x: 1120, y: 160 },
          data: { label: "健康检查", config: { method: "GET", url: "{{inputs.healthUrl}}" } },
        },
        {
          id: "notify",
          type: "notify",
          position: { x: 1400, y: 160 },
          data: {
            label: "通知",
            config: { title: "部署完成", body: "部署状态：{{nodes.deploy.output.status}}" },
          },
        },
        {
          id: "end",
          type: "end",
          position: { x: 1680, y: 160 },
          data: { label: "结束", config: {} },
        },
      ],
      edges: [
        { id: "e1", source: "start", target: "pull" },
        { id: "e2", source: "pull", target: "approve" },
        { id: "e3", source: "approve", target: "deploy" },
        { id: "e4", source: "deploy", target: "health" },
        { id: "e5", source: "health", target: "notify" },
        { id: "e6", source: "notify", target: "end" },
      ],
    }),
  },
  {
    key: "daily-trending",
    name: "每日热榜摘要",
    description: "每天定时刷新热榜，由研究 Agent 写一份中文速览并推送通知",
    build: () => ({
      name: "每日热榜摘要",
      description: "刷新 GitHub/HF/HN 热榜并生成速览",
      trigger: { type: "schedule", time: "09:00" },
      inputs: [],
      nodes: [
        {
          id: "start",
          type: "start",
          position: { x: 0, y: 120 },
          data: { label: "开始", config: {} },
        },
        {
          id: "refresh",
          type: "tool",
          position: { x: 280, y: 120 },
          data: { label: "刷新热榜", config: { tool: "feed.refresh", args: "{}" } },
        },
        {
          id: "digest",
          type: "agent",
          position: { x: 560, y: 120 },
          data: {
            label: "研究 Agent 速览",
            config: {
              agent: "research",
              task: "阅读今天的热榜（调用 feed.today），挑出最值得关注的 5 个项目，用中文写一份速览。",
            },
          },
        },
        {
          id: "notify",
          type: "notify",
          position: { x: 840, y: 120 },
          data: {
            label: "推送",
            config: { title: "今日技术速览", body: "{{nodes.digest.output}}" },
          },
        },
        {
          id: "end",
          type: "end",
          position: { x: 1120, y: 120 },
          data: { label: "结束", config: { output: "{{nodes.digest.output}}" } },
        },
      ],
      edges: [
        { id: "e1", source: "start", target: "refresh" },
        { id: "e2", source: "refresh", target: "digest" },
        { id: "e3", source: "digest", target: "notify" },
        { id: "e4", source: "notify", target: "end" },
      ],
    }),
  },
  {
    key: "blank",
    name: "空白工作流",
    description: "从开始和结束节点开始搭建",
    build: () => ({
      name: "未命名工作流",
      description: "",
      trigger: { type: "manual" },
      inputs: [],
      nodes: [
        {
          id: "start",
          type: "start",
          position: { x: 0, y: 100 },
          data: { label: "开始", config: {} },
        },
        {
          id: "end",
          type: "end",
          position: { x: 400, y: 100 },
          data: { label: "结束", config: {} },
        },
      ],
      edges: [{ id: "e1", source: "start", target: "end" }],
    }),
  },
];
