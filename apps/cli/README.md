# AgentDesk CLI

复用 AgentDesk 引擎的独立本地 CLI。支持后台服务、模型配置、流式聊天、持久化任务、工具审批与诊断。

npm 包名为 `chuxin-agentdesk`，安装后命令是 `agentdesk`。许可证目前为 `UNLICENSED`（保留权利，不是开源许可）。远程机器、团队账号和 Web 工作台尚未提供。

## 安装

需要 Node.js 22.12+、Git。

```powershell
npm install -g chuxin-agentdesk
agentdesk --help
agentdesk init
agentdesk
```

## 本地构建

源码构建还需要项目的 pnpm 开发环境。

```powershell
pnpm install
pnpm build:cli

# 生成 tarball，随后在仓库外安装它；无需全局安装即可试运行。
pnpm --filter ./apps/cli pack --pack-destination ../../release
npm install --prefix <安装目录> <tarball路径>
<安装目录>/node_modules/.bin/agentdesk --help
```

运行包不包含构建机的 Node 二进制、预编译数据库模块、开发环境配置或私有技能。`better-sqlite3` 与 `playwright-core` 作为正式依赖在目标环境安装。原生依赖没有匹配预编译文件时需要对应平台的构建工具。`playwright-core` 不下载浏览器，浏览器工具需要机器上可用的 Chrome 或 Edge。

## 使用

```powershell
agentdesk start
agentdesk init
agentdesk chat                               # 打开持久化交互式会话
agentdesk chat "我有哪些项目"                 # 一次性流式对话并退出
agentdesk chat "帮我分析这个问题" --agent code
agentdesk run "梳理还没提交的项目"
agentdesk tasks
agentdesk status
agentdesk logs --follow
agentdesk doctor
agentdesk stop
```

`init`、`chat`、`run`、`tasks`、`inspect`、`cancel`、`resume`、`approvals`、`approve`、`reject` 等命令在本地服务未运行时会自动在后台拉起服务并等待就绪后继续执行（交互终端下会看到一行启动提示），不需要每次手动先执行 `agentdesk start`；仍然可以显式用 `start`/`stop`/`restart`/`status` 管理服务生命周期，这四个命令的行为不受影响。

在真实交互终端下，不带任何子命令直接执行 `agentdesk` 会跳过帮助页：已配置模型时直接进入持久化交互式会话（等同于 `agentdesk chat`）；未配置模型时先完成一次 `init` 配置向导，正常完成后无缝接续进入会话，不需要再手动敲一次 `chat`。脚本、CI 或管道等非交互环境下裸执行 `agentdesk` 行为不变，仍打印帮助；显式执行 `agentdesk help`/`--help`/`chat`/`init` 等命令的行为也不受影响。

`init` 在服务启动后交互配置模型地址、名称和 API Key，密钥输入不回显，并由现有 sidecar 密钥存储加密保存。CLI 独立运行使用本地密钥文件，和桌面端的系统钥匙串方式不同。`init` 保存配置但不自动调用模型；使用自己的有效模型完成聊天后才算连通验证。

交互终端采用 Vite+ 官方 `@voidzero-dev/vite-plus-prompts` 组件，提供带连接线的配置向导、方向键协议选择、输入占位提示、就地校验及密钥掩码。选项确认后收起菜单，只保留结果。已有模型时，重新执行 `init` 可以选择保留或重新配置。

新增欢迎标语、渐变标题、Emoji 场景图标和步骤流动反馈。源码仓库中执行 `pnpm cli:preview` 可以独立预览，无需服务或真实密钥，不会保存配置。`--no-motion` 关闭动效，`--no-emoji` 关闭表情。字体与字号由终端软件设置，详见 [终端外观与动效](./TERMINAL.md)。

方向键选择后按 Enter 确认，Esc 或 Ctrl+C 取消。全局 `--plain` 关闭颜色、动画和方向键菜单，改用编号输入；`--no-color` 或 `NO_COLOR` 环境变量只禁用颜色。管道输出与 `TERM=dumb` 自动禁用颜色和光标动画。`status`、`doctor`、`approvals` 的 `--json` 输出保持纯 JSON，聊天的 `--json` 保持 NDJSON。终端组件在构建时打入 CLI bundle，上游许可随发行包保留。

### 放在 D 盘，避免占用系统盘

`npm install -g` 表示全局安装，具体位置由 `npm prefix -g` 决定。CLI 无需全局安装；下面将安装目录、npm 缓存、临时文件与运行数据全部指定到 D 盘。请把 tarball 路径替换为自己的实际文件。

```powershell
New-Item -ItemType Directory -Force D:/AgentDesk/tmp | Out-Null
$env:TEMP = 'D:/AgentDesk/tmp'
$env:TMP = $env:TEMP
$env:AGENTDESK_CLI_HOME = 'D:/AgentDesk/data'
npm install --prefix D:/AgentDesk/install D:/agent/AgentDesk/release/agentdesk-cli-0.1.0.tgz --cache D:/AgentDesk/npm-cache

& D:/AgentDesk/install/node_modules/.bin/agentdesk.cmd start
& D:/AgentDesk/install/node_modules/.bin/agentdesk.cmd init
```

这些环境变量仅作用于当前 PowerShell 会话。新终端需要重新设置数据目录，或为每条命令指定相同的 `--data-dir D:/AgentDesk/data`。界面中的 `agentdesk ...` 示例要求该命令已在 PATH 中；本地安装时使用上面的 `.cmd` 完整路径替换 `agentdesk`。

服务器自动化初始化可以从环境变量读取密钥，避免把密钥放到命令行参数中：

```powershell
# 先在当前进程环境中配置自己的 AGENTDESK_MODEL_KEY。
agentdesk init --base-url https://api.example.com/v1 --model <模型名称> --api-key-env AGENTDESK_MODEL_KEY
```

支持 `openai-completions` 和 `anthropic-messages`，可通过 `--api` 选择。重新初始化会更新名为 `AgentDesk CLI` 的同协议 Provider，并将内置 Agent 绑定到它。已有其他 Provider 时，无参数的 `init` 仅提示已有配置。

## 服务与数据

- CLI 默认数据根目录为 `~/.agentdesk`，通过全局参数 `--data-dir <目录>` 或 `AGENTDESK_CLI_HOME` 修改。对同一实例执行命令时使用同一数据目录。
- 根目录保存实例状态和后台日志，`data/` 保存数据库、加密凭据、用户技能和浏览器资料。
- 默认监听 `127.0.0.1:17891`；`start --port 0` 自动选空闲端口，或 `--port <端口>` 指定。
- CLI 与桌面默认使用不同数据目录、数据库和端口，当前不自动同步两者的数据。
- 每次服务启动生成随机认证令牌。CLI 从本地实例状态读取，正常命令不会打印令牌。
- `start` 默认脱离终端后台运行，`start --foreground` 在当前终端运行，适合交给 systemd、pm2 或容器管理。首版不包含开机自启或崩溃自动拉起；可由外部进程管理器提供。
- `stop` 通过带认证且身份匹配的服务接口关闭实例，不对无法确认身份的 PID 强制结束。
- `restart` 保留当前端口，已停止实例默认回到 17891；指定端口可覆盖。
- 后台日志超过 10 MB 时在下次启动轮转，保留一份 `.1`。前台日志由当前终端或外部进程管理器收集。
- CLI 仅读取数据根目录及 `data/` 下的 `.env`，不自动导入源码仓库的 `.env`。

## 聊天与审批

聊天支持 `--conversation <ID>` 接续对话，`--json` 输出 NDJSON 事件。交互终端中的工具审批需要明确回答；非交互模式或 JSON 模式遇到工具审批默认拒绝，绝不默认授权。

### 交互式会话

真实交互终端（TTY）下不带消息、不带 `--json` 执行 `agentdesk chat` 会打开持久化会话：会话保持常驻，可连续多轮对话而不需要每次重新敲命令；只带消息参数、带 `--json`，或在非交互环境下仍走和今天完全一致的一次性流式路径并立即退出。

```powershell
agentdesk chat                               # 打开新会话（无历史会话时直接新建；有历史会话时先看到选择器）
agentdesk chat --agent code                  # 指定默认 Agent
agentdesk chat --conversation <会话ID>        # 显式续接已有会话，跳过选择器，先回放历史
```

不带 `--conversation` 启动时，若本地已有历史会话，会先展示一个选择器：“新建对话”排在最前，其后按最近更新时间倒序列出历史会话（标题过长会截断，时间显示为相对时间或简短日期）。用 `↑↓` 或 `j`/`k` 选择，`Enter` 确认进入该会话（回放历史）或新建对话，`Esc` 取消选择并退出 CLI。若没有历史会话，或读取会话列表失败，会直接跳过选择器新建对话（失败时在 stderr 打印一行提示）。

会话内支持：

- 已完成的轮次滚动保留在历史区，当前这一轮实时显示流式文本、路由与工具调用卡片。
- 按 `o` 整体展开/折叠当前这一轮所有工具调用的参数与结果。
- 当前这一轮有工具调用步骤时，按 `Tab` 在输入框焦点与步骤导航焦点之间切换；步骤导航焦点下用 `↑↓` 或 `j`/`k` 移动高亮行（左侧竖线标记），`Enter` 或空格单独展开/折叠该行，`Esc` 或再按一次 `Tab` 返回输入框。已经滚入历史区的过往轮次不支持这种逐行焦点导航。
- 遇到需要审批的工具调用会弹出卡片，按 `y` 批准、按 `n` 或 `Esc` 拒绝；审批期间输入框暂停，连接保持不断开。
- 空闲时 `Ctrl+C` 退出会话；流式或等待审批时 `Ctrl+C` 只中断当前这一轮，回到可继续输入的状态。
- 顶部状态栏每 15 秒刷新跨会话的待处理审批数量（来自其他客户端或工作流产生的审批），处理这些审批仍使用 `agentdesk approvals`/`approve`/`reject`。
- 一轮对话完成后最终回答按 Markdown 渲染；流式阶段显示原始文本，避免半截 markdown 渲染错乱。`--plain`/`--no-color`/`NO_COLOR` 下不做终端着色。

```powershell
agentdesk approvals
agentdesk approve <审批ID>
agentdesk reject <审批ID>
```

`chat` 仍使用实时对话。中断终端或断开连接会取消当前这一轮。持久化任务使用下面的 `run`，不走这条会随连接取消的路径。远程机器接入仍不在本版范围内。

## 持久化任务

任务保存在本地服务里。一次任务可以有多次运行，历史都会留下。关闭终端、Ctrl+C 或断开 `inspect --follow` 只停止本地查看，任务继续执行。停止任务必须使用 `cancel`。

```powershell
agentdesk run "修复登录页报错"
agentdesk run "补充边界测试" --conversation <任务ID>
agentdesk run "先给出改动方案" --plan
agentdesk tasks
agentdesk tasks --status failed
agentdesk inspect <任务ID>
agentdesk inspect <任务ID> --follow
agentdesk cancel <任务ID>
agentdesk resume <任务ID>
agentdesk resume <任务ID> --message "从失败的测试继续"
```

- `run` 必须带任务目标。`--agent` 指定 Agent。`--plan` 先只产出方案；方案未批准时，不能用 `resume` 开始执行。
- `run --conversation` 里的 ID 是任务 ID，用来给已有任务再开一轮，不是 `chat --conversation` 的会话 ID。
- 交互终端且不带 `--json` 时，`run`、`inspect --follow` 和 `resume` 打开任务界面，事件结束后退出。带 `--json` 或非交互环境逐行输出事件。`--json` 先输出一行 `{"taskId":"..."}`，再输出 `{"seq","event"}`。
- 任务状态为 `pending`、`queued`、`planning`、`awaiting_plan_approval`、`running`、`awaiting_review`、`completed`、`failed`、`cancelled`、`closed`。`tasks --status` 按其中一种过滤。
- 普通任务执行结束后停在 `awaiting_review` 或 `completed`，这时 `run` 以成功退出。`inspect` 显示概况、待处理审批和最近事件。方案目前只能看到版本号，不能查看方案正文。
- 带 `--plan` 的任务在方案获批后进入 `running`，这一步不会自动再开执行轮。批准后用 `run "按已批准方案执行" --conversation <任务ID>` 继续。方案和验收审批都用 `approvals`、`approve`、`reject` 处理。
- `resume` 用于失败或已取消的任务。不传 `--message` 时使用「继续执行」，并把上次失败原因和已完成的工具摘要带进新的一轮。
- 服务重启后，中断时仍标记为运行中的任务会标为失败，可用 `resume` 继续。尚未开始、仍在排队的运行会重新调度。
- CLI 还没有单独的验收放弃或归档关闭命令。桌面端的「编码现场」可查看任务、执行事件与文件差异。

`status` 在服务未运行时返回非零退出码，`doctor` 在必要条件未就绪时返回非零退出码；聊天收到错误或未收到完成事件时同样返回非零退出码。

## 发行验证

更新本地预览版时，先执行 `agentdesk stop`，在原安装目录重新安装新 tarball，再执行 `agentdesk start`。指定相同的 `--data-dir` 即继续使用已有配置和数据库；替换安装包不会自动删除用户数据。源码方式重新运行 `pnpm build:cli` 后重启服务。正式 npm 发布后的升级与版本兼容策略将在相应版本提供。

```powershell
pnpm --filter ./apps/cli test
pnpm --filter ./apps/cli typecheck
pnpm build:cli
pnpm --filter ./apps/cli test:dist
pnpm --filter ./apps/cli test:package
```

先检查 tarball 文件列表，在仓库外安装并验证 help、start、认证、重复启动、init、chat、status、logs、restart 与 stop，再发布。已发布版本可用 `npm install -g chuxin-agentdesk` 安装。

## TypeScript 开发入口

CLI 业务源码使用 `.ts` / `.tsx`，构建与预览脚本也使用 TypeScript，通过本地开发依赖 `tsx` 运行。`typecheck` 同时检查业务源码、构建脚本和 TypeScript 测试；测试 runner 使用 `node --import tsx`，源码内部的 `.js` 导入会解析到对应 `.ts` / `.tsx`。

发行文件仍生成 `dist/index.mjs`、`dist/runtime.mjs` 和独立的 `dist/scripts/ai-commit-worker.mjs`，安装后的用户只需要 Node，不需要 TypeScript 编译器或 `tsx`。开发提交 worker 使用 `.ts`，由启动代码显式注入本地 `tsx`；桌面和 CLI 打包时会编译成独立 `.mjs`。

`test/fixtures/fake-tty-probe.mjs` 保留原生 Node 入口，用于验证发行包不依赖 TS 加载器也能启动交互界面。`test/fixtures/service.mjs` 只是子进程引导壳，先注册 `tsx` 再加载带类型检查的 `service.ts`。旧 JSX loader 已移除。

构建产物检查可通过上面的 `test:dist` / `test:package` 运行；验证仓库外安装包时，在仓库根目录执行 `pnpm exec tsx apps/cli/test/package-smoke.ts <已安装包目录>`。
