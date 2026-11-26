import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const sections = {
  "/": "bot-与工具对话不止于回答",
  "/session-hub": "会话中心",
  "/projects": "项目管理连接多平台围绕本地仓库工作",
  "/code": "编码任务从目标到可检查的改动",
  "/team": "团队开发各自运行-agent统一验收",
  "/collaboration": "群聊讨论围绕同一个问题协作",
  "/deploy": "工作流部署与技术发现",
  "/disk": "核心能力",
  "/workflows": "工作流部署与技术发现",
  "/automations": "自动化设定目标按计划持续推进",
  "/skills": "技能与记忆扩展自己的工作方式",
  "/learning": "源码导读与成长中心把理解和练习留在工作流里",
  "/learning/interview": "源码导读与成长中心把理解和练习留在工作流里",
  "/feed": "工作流部署与技术发现",
} as const;

export function WelcomeLink({
  to,
  install,
  children,
  ...props
}: {
  to: keyof typeof sections;
  install?: boolean;
  children?: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  if (import.meta.env.MODE === "welcome") {
    const section = install ? "快速开始" : sections[to];
    return (
      <a {...props} href={`https://github.com/exploitationExplorers/AgentDesk#${section}`}>
        {install ? "安装工作台" : children}
      </a>
    );
  }
  return (
    <Link {...props} to={to}>
      {install ? "进入工作台" : children}
    </Link>
  );
}
