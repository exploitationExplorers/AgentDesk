import type { AgentName } from "@agentdesk/shared";
import { Bot, Code2, FolderGit2, Rocket, Telescope, type LucideIcon } from "lucide-react";

export const AGENT_META: Record<
  AgentName,
  { label: string; icon: LucideIcon; description: string }
> = {
  orchestrator: { label: "AgentDesk", icon: Bot, description: "自动判断并委派给合适的 Agent" },
  project: { label: "项目", icon: FolderGit2, description: "仓库状态、PR/MR、Claude 会话" },
  deploy: { label: "部署", icon: Rocket, description: "宝塔一键部署与排障" },
  research: { label: "研究", icon: Telescope, description: "热榜与前沿技术讲解" },
  code: { label: "编码", icon: Code2, description: "浏览器 / 改文件 / Cursor / 终端" },
};

export const TOOL_LABELS: Record<string, string> = {
  "agents.delegate": "委派 Agent",
  "projects.list": "查看项目列表",
  "projects.status": "读取项目状态",
  "projects.activity": "拉取 PR/MR",
  "projects.open": "打开项目",
  "projects.pull": "git pull",
  "projects.scan": "扫描项目",
  "claude.sessions": "Claude 会话",
  "claude.run": "Claude Code 改代码",
  "deploy.list": "查看部署配方",
  "deploy.runs": "查看部署记录",
  "deploy.run": "执行部署",
  "feed.today": "读取今日热榜",
  "feed.search": "搜索热榜",
  "feed.refresh": "刷新热榜",
  "feed.digest": "生成速览",
  "web.fetch": "阅读网页",
  "workflow.list": "查看工作流",
  "workflow.run": "运行工作流",
  "shell.run": "执行命令",
  "skills.load": "加载技能",
  "browser.open": "打开浏览器",
  "browser.act": "浏览器操作",
  "browser.snapshot": "读取页面",
  "browser.reveal": "弹出浏览器接管",
  "browser.close": "关闭浏览器",
  "fs.read": "读取文件",
  "fs.write": "写入文件",
  "fs.patch": "修补文件",
  "fs.glob": "列出文件",
  "fs.search": "搜索代码",
};
