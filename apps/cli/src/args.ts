import { parseArgs } from "node:util";

const COMMON = ["help", "data-dir", "plain", "no-color", "no-motion", "no-emoji"];
const COMMAND_OPTIONS = {
  start: ["foreground", "port"],
  restart: ["foreground", "port"],
  stop: [],
  status: ["json"],
  logs: ["follow", "lines"],
  doctor: ["json"],
  init: ["base-url", "model", "api", "api-key-env"],
  chat: ["agent", "conversation", "json"],
  approvals: ["json"],
  approve: [],
  reject: [],
  run: ["agent", "plan", "conversation", "json"],
  tasks: ["status", "json"],
  inspect: ["follow", "json"],
  cancel: ["json"],
  resume: ["message", "json"],
  help: [],
  version: [],
};

export function parseCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      "data-dir": { type: "string" },
      plain: { type: "boolean" },
      "no-color": { type: "boolean" },
      "no-motion": { type: "boolean" },
      "no-emoji": { type: "boolean" },
      port: { type: "string", short: "p" },
      foreground: { type: "boolean", short: "f" },
      follow: { type: "boolean" },
      lines: { type: "string" },
      json: { type: "boolean" },
      "base-url": { type: "string" },
      model: { type: "string" },
      api: { type: "string" },
      "api-key-env": { type: "string" },
      agent: { type: "string" },
      conversation: { type: "string" },
      plan: { type: "boolean" },
      status: { type: "string" },
      message: { type: "string" },
    },
  });
  const requested = values.version ? "version" : (positionals.shift() ?? "help");
  if (!Object.hasOwn(COMMAND_OPTIONS, requested))
    throw new Error(`未知命令：${requested}。执行 agentdesk --help 查看用法。`);
  const command = requested as keyof typeof COMMAND_OPTIONS;
  if (!values.help && !values.version) {
    const allowed = new Set([...COMMON, ...COMMAND_OPTIONS[command]]);
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) throw new Error(`${command} 不支持 --${key}。`);
    }
  }
  if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535)) {
    throw new Error("--port 必须为 0～65535 的整数，0 表示自动选择端口。");
  }
  if (
    values.lines !== undefined &&
    (!/^\d+$/.test(values.lines) || Number(values.lines) < 1 || Number(values.lines) > 1000)
  ) {
    throw new Error("--lines 必须为 1～1000 的整数。");
  }
  if (!values.help && !values.version) {
    if (["approve", "reject"].includes(command)) {
      if (positionals.length !== 1) throw new Error(`${command} 需要一个审批 ID。`);
    } else if (["inspect", "cancel", "resume"].includes(command)) {
      if (positionals.length !== 1) throw new Error(`${command} 需要一个任务 ID。`);
    } else if (!["chat", "run"].includes(command) && positionals.length)
      throw new Error(`${command} 不接受额外的位置参数。`);
  }
  return { command, values, positionals };
}

export type CliValues = ReturnType<typeof parseCommand>["values"];

export const HELP = `AgentDesk — 本地 Agent 工作台命令行

用法：agentdesk <命令> [参数]

开始使用
  start → init → chat "你好"

服务管理
  start                  在后台启动独立本地服务
  start --foreground     在当前终端运行（可由进程管理器管理）
  stop / restart         停止 / 重启当前 CLI 实例
  status [--json]        查看实例状态
  logs [--follow]        查看日志（--lines 80，最多 1000 行）
  doctor [--json]        检查 Node、Git、发行文件和模型配置

模型与对话
  init                   初始化模型（交互终端完成后进入对话；密钥隐藏输入）
  chat                   打开持久化交互式会话（需交互终端，--agent code，--conversation ID 续接历史）
  chat "消息"            一次性流式对话并退出（--agent code，--conversation ID，--json）
  
工具审批
  approvals              列出待处理审批
  approve ID / reject ID 明确批准 / 拒绝指定审批
  version                显示版本

持久化任务（可跨进程重连、断开不影响后端执行）
  run "目标"             创建任务并跟随执行（--agent，--plan 要求方案审批，--json）
  run "目标" --conversation ID
                         对已有任务追加一次新的运行（ID 为任务 ID，沿用 --conversation 这个
                         参数名是为了和 chat 续接历史的心智一致，但这里传的是任务 ID 不是会话 ID）
  tasks [--status=S]     列出任务（--json）
  inspect ID [--follow]  查看任务状态、待处理审批与最近事件；--follow 续接后续事件
  cancel ID [--json]     显式取消任务（关闭终端/断开连接不会取消，必须用这个命令）
  resume ID [--message]  对失败/取消的任务重新发起一次运行并跟随执行

全局参数：
  --data-dir <目录>      CLI 数据根目录（默认 ~/.agentdesk）
  --plain                简洁输出与文本输入，禁用动画和方向键菜单
  --no-color             禁用颜色（也支持 NO_COLOR 环境变量）
  --no-motion            关闭欢迎与步骤动画，保留方向键选择
  --no-emoji             使用简单符号代替表情图标
  --help, -h             显示帮助
  --version, -V          显示版本

启动参数：--port <端口>（默认 17891，0 自动选择）、--foreground, -f
初始化参数：--base-url <URL> --model <模型> --api <协议> --api-key-env <变量名>
协议：openai-completions（默认）或 anthropic-messages。
非交互初始化从指定环境变量读取密钥，不接受命令行明文密钥。

CLI 与桌面默认使用独立实例和数据库。远程机器接入仍在后续里程碑开发。
`;
