# AgentDesk CLI

**本地优先的 Agent 工作台命令行。** 在终端对话、改代码、跑任务；同一套数据也能打开浏览器工作台。需要时，还可配对自部署的远程工作台，用手机在授权项目里发任务和处理审批。

安装后命令是 `agentdesk`。许可证为 `UNLICENSED`（保留权利，不是开源许可）。完整产品说明与界面预览见 [AgentDesk 仓库](https://github.com/exploitationExplorers/AgentDesk)。

## 快速开始

需要 **Node.js 22.12+** 和 **Git**。当前随包提供的 Autoloop 自动化运行时面向 **Windows x64**。

```powershell
npm install -g chuxin-agentdesk
agentdesk
```

交互终端里，`agentdesk` 会先引导配置模型，再让你选择：

- 打开浏览器工作台
- 进入终端对话

也可以直接进入：

```powershell
agentdesk web     # 本机浏览器工作台（与 CLI 共用数据）
agentdesk chat    # 持久化交互式终端会话
```

在设置或 `init` 中填写你自己的模型地址、名称和 API Key。密钥输入不回显，并由本地 sidecar 加密保存。配置本身不会发起模型请求；完成一轮真实对话后，才算连通验证。

## 它提供什么

| 能力         | 说明                                                               |
| ------------ | ------------------------------------------------------------------ |
| 终端 Agent   | 多轮对话、历史续接、流式输出、斜杠指令、模型与 Agent 切换          |
| 浏览器工作台 | Bot、编码现场、项目、成长中心、面试题库、工作流、自动化与设置      |
| 持久化任务   | `run` 创建任务后，关闭终端也不会中断；可查看、取消、续跑           |
| 工具审批     | 写入、提交、推送等高风险操作需明确批准；终端与工作台结果同步       |
| 多 Agent     | `orchestrator`、`code`、`project`、`deploy`、`research` 等角色协作 |
| 电脑连接器   | 配对自部署网关后，手机可在授权项目内发任务、审批与 Git 操作        |
| 自带更新提示 | 交互入口检测到新版本时可选择升级（可用环境变量跳过）               |

npm 安装提供 CLI 与浏览器工作台，**不安装** Tauri 桌面客户端。桌面端使用独立数据目录，不会与 CLI 自动同步。

## 常用命令

```powershell
agentdesk init
agentdesk web
agentdesk chat
agentdesk chat "梳理本地还有哪些未提交改动"
agentdesk chat "帮我分析这个问题" --agent code
agentdesk run "检查 README 与实现是否一致，先给出建议"
agentdesk tasks
agentdesk approvals
agentdesk doctor
agentdesk status
agentdesk logs --follow
agentdesk stop
```

`web`、`init`、`chat`、`run`、`tasks`、`inspect`、`cancel`、`resume`、`approvals` 等命令在本地服务未运行时会自动拉起服务。也可以显式使用 `start` / `stop` / `restart` 管理生命周期。

非交互或 CI 环境：裸执行 `agentdesk` 打印帮助；`status` / `doctor` / `approvals` 支持 `--json`；聊天 `--json` 输出 NDJSON。全局 `--plain`、`--no-color`、`--no-motion`、`--no-emoji` 可关闭交互装饰。

## 浏览器工作台

```powershell
agentdesk web
agentdesk web --data-dir D:/AgentDesk/data
agentdesk web --no-open          # 只打印一次性连接地址
agentdesk web --json             # 输出 { url, expiresAt }
```

工作台随包安装，无需再起 Vite 或克隆源码。浏览器与同一 `--data-dir` 的 CLI 共用模型、对话、任务和审批。「编码现场」可查看任务时间线、工具记录和文件差异。

连接地址仅限本机、短时有效且一次性使用，请勿分享。浏览器不持有 CLI 主令牌。关闭页面后，后台服务与持久化任务继续运行；实时聊天断开会取消当前轮次。

## 交互式终端

```powershell
agentdesk chat
agentdesk chat --agent code
agentdesk chat --conversation <会话ID>
```

TTY 下不带消息、不带 `--json` 时进入常驻会话：可连续多轮，实时查看流式文本、工具卡片与代码差异，并处理审批（`y` / `n`）。空闲时输入 `/` 打开指令菜单，输入 `@` 选择并插入技能（例如 `@qa-regression`），发送后会在本轮直接激活该技能。

常用斜杠指令：

| 指令                                  | 作用                       |
| ------------------------------------- | -------------------------- |
| `/help`                               | 指令与快捷键               |
| `/model`                              | 选择或刷新模型             |
| `/agents`                             | 切换 Agent                 |
| `/resume`                             | 恢复历史聊天               |
| `/clear`                              | 新上下文（不删历史）       |
| `/permissions`                        | 查看风险等级与待审批       |
| `/tools` `/skills` `/tasks` `/memory` | 查看工具、技能、任务、记忆 |
| `/export`                             | 导出当前会话为 Markdown    |
| `/doctor` `/status` `/version`        | 诊断与状态                 |
| `/exit`                               | 退出                       |

聊天里的 `/resume` 恢复的是对话；shell 里的 `agentdesk resume <任务ID>` 续跑的是失败或已取消的**任务**。终端外观与动效说明见 [TERMINAL.md](./TERMINAL.md)。

## 持久化任务

关闭终端或断开跟随**不会**取消任务；停止必须用 `cancel`。

```powershell
agentdesk run "修复登录页报错"
agentdesk run "先给出改动方案" --plan
agentdesk run "按已批准方案执行" --conversation <任务ID>
agentdesk tasks
agentdesk inspect <任务ID> --follow
agentdesk cancel <任务ID>
agentdesk resume <任务ID>
```

`run --conversation` 里的 ID 是**任务 ID**，用来给已有任务再开一轮，不是 `chat --conversation` 的会话 ID。方案与高风险工具审批通过 `approvals` / `approve` / `reject` 处理；非交互或 `--json` 遇到工具审批会明确拒绝，不会默认授权。

## 电脑连接器（可选）

先按 [Linux / 宝塔部署文档](https://github.com/exploitationExplorers/AgentDesk/blob/main/deploy/cloud/README.md) 部署 HTTPS 网关与 Runner。手机创建配对码后，在电脑上：

```powershell
agentdesk connect pair --server https://你的域名
agentdesk connect status
agentdesk connect start
```

Windows 可安装当前用户登录自启动：`connect install` / `uninstall`。撤销本机绑定：`connect revoke`。配对码隐藏输入，不要写进命令行历史。

## 配置、数据与自动化

- 默认数据目录：`~/.agentdesk`（可用 `--data-dir` 或 `AGENTDESK_CLI_HOME`）
- 默认监听：`127.0.0.1:17891`（`start --port 0` 自动选端口）
- 协议：`openai-completions`（默认）、`anthropic-messages`
- 非交互初始化从环境变量读密钥，不接受命令行明文 Key：

```powershell
agentdesk init --base-url https://api.example.com/v1 --model <模型名> --api-key-env AGENTDESK_MODEL_KEY
```

不想占用系统盘时，可把安装与数据放到其他盘：

```powershell
New-Item -ItemType Directory -Force D:/AgentDesk/tmp | Out-Null
$env:TEMP = 'D:/AgentDesk/tmp'
$env:TMP = $env:TEMP
$env:AGENTDESK_CLI_HOME = 'D:/AgentDesk/data'
npm install --prefix D:/AgentDesk/install chuxin-agentdesk --cache D:/AgentDesk/npm-cache
& D:/AgentDesk/install/node_modules/.bin/agentdesk.cmd --version
```

## 升级

```powershell
agentdesk stop
npm install -g chuxin-agentdesk
agentdesk web
```

若安装包已更新但旧服务还在跑，执行 `agentdesk restart`。保留相同 `--data-dir` 即可继续使用已有配置和数据库。设置非空 `CI`、`AGENTDESK_SKIP_UPDATE` 或 `AGENTDESK_NO_UPDATE` 可跳过交互更新提示。

## 环境说明

- CLI 主进程使用你机器上的 Node；Autoloop 自动化另含经校验的固定运行时（当前发行目标 Windows x64）
- `better-sqlite3`、`playwright-core` 会在安装时拉取；无匹配预编译模块时需要本机构建工具
- `playwright-core` 不附带浏览器，浏览器类工具需要本机 Chrome 或 Edge
- 包内不含开发环境配置或私有技能

## 从源码构建

需要仓库声明的 `pnpm@10.33.3`（pnpm 10+）、Rust 工具链，以及[固定的 Autoloop Node 运行时](https://github.com/exploitationExplorers/AgentDesk/blob/main/packages/autoloop-runtime/README.md)。在仓库根目录：

```powershell
pnpm install
pnpm build:cli
pnpm --filter ./apps/cli pack --pack-destination ../../release
```

`build:cli` 打包 CLI、运行时、公开技能和浏览器工作台，不构建桌面应用。验证：

```powershell
pnpm --filter ./apps/cli test
pnpm --filter ./apps/cli typecheck
pnpm --filter ./apps/cli test:dist
pnpm --filter ./apps/cli test:package
```

## 发布到 npm

仓库根目录一键升版并发布（默认 patch）：

```powershell
pnpm publish:cli
pnpm publish:cli -- --bump minor
pnpm publish:cli -- --bump none
pnpm publish:cli -- --dry-run
pnpm publish:cli -- --otp 123456
pnpm publish:cli -- --with-dist-smoke
```

脚本会更新 `apps/cli/package.json` 版本（可用 `--bump none` 跳过）、跑 typecheck/test/build/package smoke，再执行 `pnpm publish`。交互式 `test:dist` 默认跳过。发布后请自行提交版本号变更。

## 反馈

- 仓库：https://github.com/exploitationExplorers/AgentDesk
- Issues：https://github.com/exploitationExplorers/AgentDesk/issues
- npm：https://www.npmjs.com/package/chuxin-agentdesk
