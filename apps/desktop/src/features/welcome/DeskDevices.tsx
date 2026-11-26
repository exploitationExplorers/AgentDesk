import { Check, GitPullRequest, MessagesSquare, Terminal } from "lucide-react";
import phoneDetail from "./previews/mobile-detail.jpg";
import phoneTasks from "./previews/mobile-tasks.jpg";

export function DesktopActivity() {
  return (
    <div className="device-wallpaper">
      <div className="device-menubar">
        <b>AgentDesk</b>
        <span>工作区</span>
      </div>
      <div className="device-window session-window">
        <header>
          <i />
          <i />
          <i />
          <span>Bot 对话</span>
        </header>
        <div className="device-message">
          <MessagesSquare />
          <b>检查这次会话搜索的改动</b>
        </div>
        <div className="device-log">
          <span>正在读取项目文件</span>
          <i />
          <i />
          <i />
        </div>
        <div className="device-status">
          <Check /> 已定位到会话中心
        </div>
      </div>
      <div className="device-window run-window">
        <header>
          <i />
          <i />
          <i />
          <span>编码工作台</span>
        </header>
        <div className="device-message">
          <GitPullRequest />
          <b>会话搜索</b>
        </div>
        <div className="device-diff">
          <code>− session.title</code>
          <code>+ [title, ...messages]</code>
        </div>
        <div className="device-status">
          <Terminal /> 正在验证改动
        </div>
        <div className="device-meter">
          <i />
        </div>
      </div>
      <div className="device-run-summary">
        <b>AgentDesk · 任务进度</b>
        <span>
          读取会话记录
          <i />
        </span>
        <span>
          检查代码改动
          <i />
        </span>
        <span>
          运行测试
          <i />
        </span>
      </div>
      <div className="device-dock">
        <MessagesSquare />
        <Terminal />
        <GitPullRequest />
      </div>
    </div>
  );
}

export function PhoneDisplay() {
  return (
    <div className="phone-body">
      <div className="phone-glass">
        <img src={phoneTasks} alt="" loading="lazy" />
        <img className="phone-detail" src={phoneDetail} alt="" loading="lazy" />
      </div>
    </div>
  );
}
