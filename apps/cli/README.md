# AgentDesk CLI

复用 AgentDesk 引擎的独立本地 CLI，内置浏览器工作台。支持后台服务、模型配置、流式聊天、持久化任务、工具审批与诊断。

npm 包名为 `chuxin-agentdesk`，安装后命令是 `agentdesk`。许可证目前为 `UNLICENSED`（保留权利，不是开源许可）。浏览器工作台仅连接本机；远程机器和团队账号尚未提供。

## 安装

需要 Node.js 22.12+、Git。

```powershell
npm install -g chuxin-agentdesk
agentdesk --help
agentdesk              # 配置模型，然后选择浏览器工作台或终端对话
agentdesk web          # 随时打开浏览器工作台
```

## 本地构建

源码构建使用仓库声明的 `pnpm@10.33.3`（要求 pnpm 10+），请在仓库根目录执行以下命令。`build:cli` 会打包 CLI、运行时、公开技能和浏览器工作台（调用桌面前端的 Vite CLI 模式构建），不构建或安装桌面应用。`pack` 的 `prepack` 脚本也会执行构建。tarball 名称基于 npm 包名与版本，例如当前 `0.1.2` 对应 `chuxin-agentdesk-0.1.2.tgz`；以实际输出为准。

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
agentdesk web                                # 打开浏览器工作台，与 CLI 共用数据
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

`web`、`init`、`chat`、`run`、`tasks`、`inspect`、`cancel`、`resume`、`approvals`、`approve`、`reject` 等命令在本地服务未运行时会自动在后台拉起服务并等待就绪后继续执行（交互终端下会看到一行启动提示），不需要每次手动先执行 `agentdesk start`；仍然可以显式用 `start`/`stop`/`restart`/`status` 管理服务生命周期。

在真实交互终端下，不带任何子命令直接执行 `agentdesk` 会先检查模型配置，未配置时完成 `init` 向导，然后提供「打开浏览器工作台」和「继续终端对话」两个选项。显式执行 `agentdesk init`，完成配置或选择保留已有配置后，也会展示这个入口。希望直接进入终端对话时执行 `agentdesk chat`。脚本、CI 或管道等非交互环境下，裸执行仍打印帮助，`init` 只保存配置并提示下一步命令。

### 浏览器工作台与桌面端

```powershell
agentdesk web
agentdesk web --data-dir D:/AgentDesk/data
agentdesk web --no-open                      # 只打印连接地址，手动复制到浏览器
agentdesk web --json                         # 只输出 { url, expiresAt }，不打开浏览器
```

工作台页面随 npm 包安装，不需要克隆源码、启动 Vite 或安装桌面端。`web` 自动打开系统默认浏览器，无法自动打开时打印可复制的连接地址。进入后可以查看 Bot、编码现场、项目、工作流和设置。在设置里添加模型和项目，也可先用 `agentdesk init` 配置模型。

浏览器与使用相同 `--data-dir` 的 CLI 共用模型、对话、任务和审批。「编码现场」会显示当前实例的任务，不需要再次切换到 CLI 会话。关闭终端或页面后，后台服务与持久化任务继续运行；实时聊天断开则会取消当前轮次。使用 `agentdesk stop` 停止服务。

连接地址仅限本机使用，2 分钟内有效且只能使用一次，请勿分享。连接成功后地址栏会清除连接凭据，刷新页面仍保持登录；会话在 24 小时后或服务重启后失效，重新运行 `agentdesk web` 即可连接。浏览器不持有 CLI 主令牌。

桌面模式使用独立的 AgentDesk 安装包，安装后从系统应用入口打开。桌面默认数据目录与 CLI 不同，不会自动同步。npm 安装提供终端和浏览器入口，不安装桌面客户端。

交互终端里执行 `agentdesk`、`init`、`chat` 或 `run` 时，如果 npm 上有更新版本，会先询问：立即更新、本次跳过，或在下一个版本前不再提示。选择更新会从官方 npm registry 执行 `npm install -g chuxin-agentdesk@<检测到的版本>`，成功后重新启动当前入口和参数；安装失败则继续使用当前版本。版本检查结果缓存 1 小时。非交互或 `--json` 模式，以及设置了非空 `CI`、`AGENTDESK_SKIP_UPDATE` 或 `AGENTDESK_NO_UPDATE` 环境变量时跳过检查。本地安装或源码运行建议跳过全局更新，按原安装方式手动更新；自动更新不会替你迁移安装入口或重启旧后台服务。

`init` 在服务启动后交互配置模型地址、名称和 API Key，密钥输入不回显，并由现有 sidecar 密钥存储加密保存。CLI 独立运行使用本地密钥文件，和桌面端的系统钥匙串方式不同。`init` 保存配置但不自动调用模型；进入对话后使用自己的有效模型完成一轮聊天，才算连通验证。

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
npm install --prefix D:/AgentDesk/install D:/agent/AgentDesk/release/chuxin-agentdesk-0.1.2.tgz --cache D:/AgentDesk/npm-cache

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
- CLI 与它打开的浏览器工作台共用数据；桌面默认使用不同数据目录、数据库和端口，当前不自动同步桌面数据。
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

- 已完成的轮次滚动保留在历史区，当前这一轮实时显示流式文本、路由与工具调用卡片。实时区高度随终端行数调整；长输出超出视口时，按 `PgUp`/`PgDn` 向上/向下翻页，底部会显示当前可见行范围与总行数。翻页只移动实时区内容，不会把整屏反复推入终端回滚区；历史区内容仍通过终端自身的回滚查看。
- 实时区默认自动跟随输出末尾；向上翻页后停留在所查看的位置，不随新输出跳到底部。按 `PgDn` 回到末尾后恢复自动跟随。
- 文件写入成功后，默认显示带行号的代码差异卡片，绿色表示新增、红色表示删除，并显示增删行数；长差异可在实时区翻页，完成后保留在终端历史中。
- 按 `Ctrl+O` 整体展开/折叠工具调用详情；普通字母 `o` 会作为输入，不再是快捷键。
- 当前这一轮有工具调用步骤时，按 `Tab` 在输入框焦点与步骤导航焦点之间切换；步骤导航焦点下用 `↑↓` 或 `j`/`k` 移动高亮行（左侧竖线标记），`Enter` 或空格单独展开/折叠该行。焦点步骤会自动滚入视口，展开后也会调整可见位置；若该步骤本身高于视口，则从步骤顶部显示，可继续用 `PgUp`/`PgDn` 查看。`Esc` 或再按一次 `Tab` 返回输入框，并恢复自动跟随末尾。已经滚入历史区的过往轮次不支持这种逐行焦点导航。
- 输入框支持左右移动、`Home`/`End`、`Ctrl+A`/`Ctrl+E` 移到首尾、`Ctrl+U`/`Ctrl+K` 删除光标前后内容、`Ctrl+W` 删除前一个词；`Enter` 提交，`Shift+Enter` 换行（需终端支持）。没有指令菜单时，`↑↓` 浏览本次终端进程的输入历史，并可返回尚未提交的草稿。
- 空闲时 `Ctrl+C` 先清空非空草稿，输入为空时才退出；流式时 `Esc` 或 `Ctrl+C` 中断当前轮次，不退出会话。指令面板或加载期间按 `Esc`/`Ctrl+C` 关闭或取消指令。
- 一轮对话完成后最终回答按 Markdown 渲染；流式阶段显示原始文本，避免半截 Markdown 渲染错乱。`--plain`/`--no-color`/`NO_COLOR` 下不做终端着色。

### 斜杠指令

以下指令仅在持久化交互式 `agentdesk chat` 输入框中解析，不是 shell 子命令，也不作为聊天消息发送给模型；部分指令会查询或更新本地服务，`/export` 会写入本地文件。一次性 `chat "消息"`、`--json` 与非交互输入不会进入这套指令处理流程。

空闲时输入 `/` 展示指令菜单，用 `↑↓` 选择、`Enter` 执行、`Tab` 补全命令后继续输入参数；模型等选择面板支持输入关键词筛选，`Esc` 关闭且不改变选择。`/help <命令>` 或 `/<命令> help` 查看具体用法。未知指令会显示错误，不会交给模型执行。

| 指令                         | 作用与别名                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/help [命令]`               | 查看指令与快捷键；别名 `/?`                                                                                                             |
| `/model [模型或子命令]`      | 选择模型，详见下节                                                                                                                      |
| `/clear`                     | 开始新上下文，不删除历史；别名 `/new`、`/reset`                                                                                         |
| `/resume [会话 ID 或标题]`   | 恢复历史聊天，标题按包含关系匹配；无参数或多个匹配时打开选择器；别名 `/continue`                                                        |
| `/rename <标题>`             | 重命名已开始的会话                                                                                                                      |
| `/agents [名称]`             | 选择 Agent：`orchestrator`、`code`、`project`、`deploy`、`research`、`reviewer`；别名 `/agent`                                          |
| `/config [选项] [on 或 off]` | 调整当前终端的 `color`、`motion`、`emoji`、`verbose`；无参数打开菜单；别名 `/settings`                                                  |
| `/theme [default 或 plain]`  | 恢复启动时显示设置，或关闭颜色、动效和 Emoji；不修改持久化配置                                                                          |
| `/status`                    | 查看当前会话、Agent、模型、工作目录和服务状态                                                                                           |
| `/context`                   | 统计已保存消息数、正文字符数和工具调用数，不是 token 统计，不包含系统提示和自动召回记忆                                                 |
| `/permissions`               | 查看工具风险等级与待处理审批，仅查看，不直接授权；别名 `/approvals`                                                                     |
| `/tools [搜索词]`            | 查看工具、说明与风险等级                                                                                                                |
| `/skills [搜索词]`           | 查看已加载的 Skills                                                                                                                     |
| `/tasks [状态]`              | 查看后台任务；不会创建任务                                                                                                              |
| `/memory [搜索词]`           | 查看并筛选长期记忆；不会新增或删除记忆                                                                                                  |
| `/export [文件路径]`         | 导出已保存会话为 Markdown（含工具记录）；默认写入当前工作目录下的 `agentdesk-<会话ID>.md`，相对路径也基于当前工作目录，已有文件不会覆盖 |
| `/doctor`                    | 检查服务连接和 Provider 配置，不发起模型推理请求；不同于 shell 中的完整 `agentdesk doctor` 环境诊断                                     |
| `/version`                   | 显示 CLI 版本                                                                                                                           |
| `/exit`                      | 退出终端会话；别名 `/quit`                                                                                                              |

注意：聊天内的 `/resume` 恢复的是聊天会话；shell 中的 `agentdesk resume <任务ID>` 重跑的是失败或已取消的持久化任务。启动参数 `--agent` 当前仅接受 `orchestrator`、`project`、`deploy`、`research`、`code`，与交互菜单额外提供的 `reviewer` 不同。

### 模型选择

```text
/model                         # 打开模型选择面板，可输入关键词筛选
/model <模型名称>              # 在可用模型中选择；未列出的名称使用当前/默认 Provider
/model <Provider ID>/<模型>    # 明确指定 Provider，也支持 Provider 名称前缀
/model info                    # 查看当前覆盖或默认模型（也支持 status）
/model refresh                 # 从已启用且有密钥的 Provider 拉取远端模型列表并打开菜单
/model default                 # 清除覆盖，恢复 Agent 默认绑定和回退策略
```

- 菜单只列出已启用且有 API Key 的 Provider，合并其默认模型、已配置模型和 Agent 绑定模型。同名模型存在于多个 Provider 时必须明确指定 Provider 或从菜单选择。
- 可以输入未列出的自定义模型名称，但切换本身不验证模型是否真实可用；无认证本地接口仍需先保存其允许的非空占位 Key。
- 选择从下一轮聊天请求起生效，只保存在当前终端进程内，不写入全局 Provider 或 Agent 绑定，也不随聊天记录恢复。`/clear` 和 `/resume` 不重置此覆盖，退出后重新进入则回到默认配置。
- 显式选择只使用指定 Provider/模型，不自动回退到其他 Provider。默认模式按当前 Agent 绑定（没有时使用总控绑定）、备用 Provider、其余 Provider 的顺序尝试，跳过停用或无密钥的 Provider。`/agents` 切换 Agent 时，已有显式模型覆盖仍保留。
- `/model refresh` 会使用已保存的凭据请求远端模型列表，但不发起推理；结果只合并到本次面板，不保存到 Provider 配置。部分 Provider 刷新失败会提示并保留已配置模型。
- `chat` 和 `run` 没有 `--model` 参数；`init --model` 用于保存初始化配置，不是单轮覆盖。需要持久修改时使用工作台设置或重新执行 `agentdesk init`。

### 工具审批与跨端同步

- `git status`、`diff`、`log`、`show`、`rev-parse`、`ls-files` 等已识别的只读查询直接执行，包括由 `;`、`&&`、`||` 串联的只读 Git 查询。写入、提交、推送及未识别命令仍按具体操作审批。
- 已批准或拒绝的审批收为一行记录，不再重复显示整个详情卡片。
- 交互聊天遇到审批会弹出卡片，按 `y` 批准，按 `n` 或 `Esc` 拒绝；审批期间输入框暂停，连接保持不断开。`Ctrl+C` 中断当前轮次，不等同于批准。等待审批表示任务暂停，核对详情并按 y 后会继续执行；完成后返回输入状态。
- 待审批卡片的标题与详情从顶部开始显示，不自动跟随末尾；内容过长时可用 `PgUp`/`PgDn` 翻页，也可用 `↑↓` 逐行滚动，超出视口时显示当前可见行范围与总行数。卡片顶部的「需要审批」和底部的「按 y 批准 · 按 n 或 Esc 拒绝」提示固定在滚动详情之外，翻页时仍保持可见；翻页不会提交审批决定。
- 待审批数量及当前等待的审批决定每 1.5 秒轮询同步；在浏览器工作台或其他 CLI 中处理同一审批后，终端会同步结果并继续，不重复提交决定。
- `/permissions` 只展示权限与审批。其他会话或工作流的待处理审批，可在工作台处理，或使用下面的 shell 命令。一次性聊天、任务事件流在非交互或 JSON 模式下遇到工具审批会明确拒绝，不自动授权。

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
- CLI 还没有单独的验收放弃或归档关闭命令。运行 `agentdesk web`，在「编码现场」查看任务、执行事件与文件差异。

`status` 在服务未运行时返回非零退出码，`doctor` 在必要条件未就绪时返回非零退出码；聊天收到错误或未收到完成事件时同样返回非零退出码。

## 发行验证

更新时先执行 `agentdesk stop`，再运行 `npm install -g chuxin-agentdesk@latest`，最后执行 `agentdesk web`。若已更新安装包但旧服务还在运行，先执行 `agentdesk restart`。指定相同的 `--data-dir` 即继续使用已有配置和数据库；替换安装包不会自动删除用户数据。本地 tarball 更新使用相同流程；源码方式重新运行 `pnpm build:cli` 后重启服务。

```powershell
pnpm --filter ./apps/cli test
pnpm --filter ./apps/cli typecheck
pnpm build:cli
pnpm --filter ./apps/cli test:dist
pnpm --filter ./apps/cli test:package
pnpm --filter @agentdesk/desktop test:cli-workbench
```

先检查 tarball 文件列表包含 `dist/web/index.html` 和前端资源，在仓库外安装并验证 help、start、浏览器连接、认证、重复启动、init、chat、status、logs、restart 与 stop，再发布。浏览器验证使用系统 Edge，可用 `E2E_BROWSER_CHANNEL` 指定已安装的 Chrome；`test:cli-workbench` 可附加已安装包目录，验证独立安装产物。

## TypeScript 开发入口

CLI 业务源码使用 `.ts` / `.tsx`，构建与预览脚本也使用 TypeScript，通过本地开发依赖 `tsx` 运行。`typecheck` 同时检查业务源码、构建脚本和 TypeScript 测试；测试 runner 使用 `node --import tsx`，源码内部的 `.js` 导入会解析到对应 `.ts` / `.tsx`。

发行文件仍生成 `dist/index.mjs`、`dist/runtime.mjs` 和独立的 `dist/scripts/ai-commit-worker.mjs`，安装后的用户只需要 Node，不需要 TypeScript 编译器或 `tsx`。开发提交 worker 使用 `.ts`，由启动代码显式注入本地 `tsx`；桌面和 CLI 打包时会编译成独立 `.mjs`。

`test/fixtures/fake-tty-probe.mjs` 保留原生 Node 入口，用于验证发行包不依赖 TS 加载器也能启动交互界面。`test/fixtures/service.mjs` 只是子进程引导壳，先注册 `tsx` 再加载带类型检查的 `service.ts`。旧 JSX loader 已移除。

构建产物检查可通过上面的 `test:dist` / `test:package` 运行；验证仓库外安装包时，在仓库根目录执行 `pnpm exec tsx apps/cli/test/package-smoke.ts <已安装包目录>`。
