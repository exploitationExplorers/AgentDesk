import {
  Blocks,
  BookOpen,
  Code2,
  GitPullRequest,
  MessagesSquare,
  Smartphone,
  Workflow,
} from "lucide-react";
import mobile from "./previews/mobile-tasks.jpg";
import desk from "./previews/mac-desk.jpg";
import code from "./previews/code.jpg";
import team from "./previews/team-execution.jpg";
import workflow from "./previews/workflow.jpg";
import deploy from "./previews/deploy.jpg";
import learning from "./previews/learning.jpg";

export const scenes = [
  {
    kind: "laptop",
    camera: { radius: 107, pitch: 0.3, yaw: 0.24, targetHeight: 8 },
    title: "对话与会话",
    headline: ["你的 Agent", "工作台。"],
    icon: MessagesSquare,
    image: desk,
    caption: "AgentDesk 桌面工作台",
    tint: "#b6eed5",
    description: "从一次对话开始，让 Agent 读代码、跑任务。离开电脑，也能在手机上接着看进度。",
    links: [
      ["打开 Bot", "/"],
      ["会话中心", "/session-hub"],
    ],
  },
  {
    kind: "editor",
    camera: { radius: 83, pitch: 0.22, yaw: 0.08, targetHeight: 11 },
    title: "项目与编码",
    headline: ["从想法，", "到代码。"],
    icon: Code2,
    image: code,
    caption: "编码工作台",
    tint: "#bfdbff",
    description: "找到仓库，读懂目录和源码，再把要改的地方交给编码 Agent。",
    links: [
      ["编码工作台", "/code"],
      ["项目列表", "/projects"],
    ],
  },
  {
    kind: "phone",
    camera: { radius: 115, pitch: 1.16, yaw: 0.04, targetHeight: 2 },
    title: "手机工作台",
    headline: ["在手机上，", "接着工作。"],
    icon: Smartphone,
    image: mobile,
    caption: "手机远程任务",
    tint: "#c6e8dd",
    description:
      "连接自部署的远程工作台，在手机浏览器里发起任务、查看执行记录，处理需要你确认的审批。",
    links: [],
  },
  {
    kind: "board",
    camera: { radius: 91, pitch: 0.25, yaw: -0.12, targetHeight: 10 },
    title: "团队协作",
    headline: ["和团队", "一起推进。"],
    icon: GitPullRequest,
    image: team,
    caption: "团队任务执行",
    tint: "#decaff",
    description: "用本地群聊核对想法，在团队项目里分派任务、查看执行记录和验收改动。",
    links: [
      ["本地群聊", "/collaboration"],
      ["团队开发", "/team"],
    ],
  },
  {
    kind: "canvas",
    camera: { radius: 82, pitch: 0.2, yaw: 0.1, targetHeight: 11 },
    title: "工作流与自动化",
    headline: ["把步骤", "连成流程。"],
    icon: Workflow,
    image: workflow,
    caption: "工作流画布",
    tint: "#ffe0a8",
    description: "在画布上连接步骤，把需要重复执行的任务设成定时自动化。",
    links: [
      ["工作流", "/workflows"],
      ["自动化", "/automations"],
      ["技能库", "/skills"],
    ],
  },
  {
    kind: "console",
    camera: { radius: 96, pitch: 0.32, yaw: 0.22, targetHeight: 9 },
    title: "部署与维护",
    headline: ["从部署", "到维护。"],
    icon: Blocks,
    image: deploy,
    caption: "部署工作台",
    tint: "#ffcbb8",
    description: "选择部署配方，跟踪执行日志，也可以检查本机磁盘占用和可清理空间。",
    links: [
      ["部署", "/deploy"],
      ["磁盘空间", "/disk"],
    ],
  },
  {
    kind: "journal",
    camera: { radius: 104, pitch: 0.27, yaw: 0.06, targetHeight: 8 },
    title: "发现与成长",
    headline: ["把发现", "变成进步。"],
    icon: BookOpen,
    image: learning,
    caption: "成长中心",
    tint: "#c6e4f3",
    description: "从技术热榜发现选题，在成长中心安排学习计划，用面试练习检验掌握程度。",
    links: [
      ["成长中心", "/learning"],
      ["技术热榜", "/feed"],
      ["面试练习", "/learning/interview"],
    ],
  },
] as const;
