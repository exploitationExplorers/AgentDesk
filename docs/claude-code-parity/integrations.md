# Claude Code 扩展、集成与基础设施对照

分析日期：2026-10-28。参考目录：`D:/AI code/claude-code-2.1.87/claude-code-2.1.87/src`。以下参考路径均相对于该目录；AgentDesk 路径相对于本仓库。状态描述为本次分析时的基线，后续实施结果以总报告为准。

## 覆盖方式与源码边界

全量清单 [source-inventory.json](source-inventory.json) 覆盖给定 `src` 的 **1,902 个文件、513,237 行**，记录每个文件的路径、字节数、行数和顶层模块。没有把 `node_modules`、`vendor` 当成产品源码重复统计。

本分工覆盖 **777 个文件、232,450 行**：对所有文件读取内容并提取导出声明、头部注释和目录结构，索引见 [integrations-index.json](integrations-index.json)；对下文列出的关键实现作人工深入阅读。目录/结构扫描不等于逐行人工审阅全部实现，也不等于完成安全审计。核心执行和交互模块由另外两份报告覆盖。MCP/LSP 的关键服务入口虽位于另一分工的 `services`，在本报告补充深读，统计不重复相加。

提供的目录并非可直接验证的完整构建工程：根目录未见 `package.json` 或 `tsconfig.json`，部分内部导入目标不在提供的 `src` 内。启发式审计对 **12,718 处相对导入**进行解析，已考虑源码 `.ts/.tsx` 对应导入 `.js` 的正常写法，仍有 **524 处引用、157 个唯一目标**未解析，例如 `types/message.js`、`entrypoints/sdk/controlTypes.js`、`services/contextCollapse/index.js`。完整结果见 [source-import-audit.json](source-import-audit.json)。此统计排除包导入/别名导入，不是 TypeScript 编译错误数量，缺失目标也可能属于生成文件或未提供的构建内容。

此外，`moreright/useMoreRight.tsx:1` 明确写有 external-build stub；`native-ts` 中标有 Rust/NAPI/Yoga 的纯 TypeScript 移植。只能确认这份本地材料具有这些代码，不能据此确认其与官方 2.1.87 发布产物完全一致，更不能将 feature gate 后的代码一律描述为已公开发布能力。

## 功能对照

| 能力                   | 参考实现依据                                                                                                                                                                 | AgentDesk 实际依据                                                                                            | 状态与建议                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 技能按需加载           | `skills/loadSkillsDir.ts:185` 解析 frontmatter，`:270` 构建可调用技能，`:638` 加载多来源                                                                                     | `packages/agent-core/src/skills.ts:21`、`:50`、`:97`、`:112`；系统提示只放目录，需要时 `skills.load`          | **partial**。已有渐进加载、触发词、Agent 过滤；不能说完全没有 skills。                                                      |
| Claude 技能元数据兼容  | `skills/loadSkillsDir.ts:185` 支持 `allowed-tools`、`disable-model-invocation`、`user-invocable`、`context: fork`、`agent`、`model`、`effort`、`paths`、`hooks`              | `skills.ts:37` 只读取 `allowed_tools`；无上述调用开关和执行上下文                                             | **missing/partial**。标准短横线字段会丢失，应先兼容；不支持的执行字段应明示，不能假装执行。                                 |
| 技能目录与热更新       | `skills/loadSkillsDir.ts:638` 加载受管/用户/项目/附加目录，按真实路径去重；`utils/skills/skillChangeDetector.ts:87` 监听，稳定写入等待与 debounce                            | `apps/sidecar/src/config.ts:59` 仅内置和数据目录；`container.ts:84` 启动加载一次                              | **partial**。缺工作区技能隔离、刷新入口、错误诊断和删除同步。                                                               |
| 项目指令、分层规则     | `utils/claudemd.ts:790` 按受管、用户、祖先目录到 cwd 加载 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules`、local 文件，并处理 worktree 去重                                | `agents/definitions.ts` 只提示模型主动读项目说明；未找到自动加载 `AGENTS.md`/`CLAUDE.md` 的运行链路           | **missing**。优先加入本项目适用的 `AGENTS.md`/`CLAUDE.md` 加载及来源展示，按任务工作区隔离。                                |
| 长期记忆               | `utils/claudemd.ts:790` 会注入自动记忆入口；`utils/memory` 定义版本；记忆写入细节见核心报告                                                                                  | `services/memory.ts:188` FTS5 召回，`:201` 注入，`:211` 自动抽取；已有记忆设置页                              | **present，机制不同**。当前已有长期记忆，缺的是项目规则及文件型上下文，不应重写整个记忆服务。                               |
| 生命周期 Hooks         | `utils/hooks.ts:3394` PreToolUse、`:3450` PostToolUse、`:3826` UserPromptSubmit、`:3867` SessionStart、`:3961` PreCompact；`entrypoints/sdk/coreTypes.ts:25` 事件目录        | `events.ts` 是内部事件总线，`agents/tools.ts` 是工具注册；没有用户可配置生命周期 Hook 执行器                  | **missing**。工具事件可供未来接入，但内部事件和可执行 Hook 不是同一能力。                                                   |
| Hooks 的执行与可观测性 | `utils/hooks/execHttpHook.ts:1` HTTP Hook；`execAgentHook.ts`/`execPromptHook.ts`；`hookEvents.ts:22` 开始、输出、结束事件；`hooksConfigSnapshot.ts:14` 来源策略             | 编码现场已有工具事件/输出，但无 Hook 类型、配置与运行状态                                                     | **missing**。初版宜只做有超时/取消的有限事件与命令 Hook，不必一开始实现全部 Hook 后端。                                     |
| MCP 客户端             | `services/mcp/client.ts:595` 多传输连接，`:1743` tools、`:2000` resources、`:2033` prompts，`:2226` 批量连接；`services/mcp/config.ts:69` 多来源配置                         | 扫描 `agent-core`、`integrations`、sidecar 注册入口和设置契约，未见 MCP 客户端/配置；热榜关键字 MCP 不算支持  | **missing**。应新增独立适配层，将 MCP 工具转换成现有 ToolRegistry，不与 UI 直接绑定。                                       |
| MCP 认证和用户交互     | `services/mcp/auth.ts`、`elicitationHandler.ts`、`client.ts:2813` URL elicitation 重试、`channelPermissions.ts`                                                              | 当前 Provider API key 配置与审批服务不提供 MCP OAuth、elicitation、资源订阅                                   | **missing**。是 MCP 的第二阶段，不能仅接 `callTool` 就宣称完整对齐。                                                        |
| MCP Server / Agent SDK | `entrypoints/mcp.ts` 对外暴露工具；`agentSdkTypes.ts` 提供 SDK 类型、tool 和进程内 MCP server；`sdk/controlSchemas.ts` 控制协议                                              | 已有 Hono HTTP API、SSE 事件与 shared Zod 契约；没有同等 SDK/MCP server 对外兼容层                            | **partial**。自身客户端所需 API 已存在，外部 SDK 可作为独立接口产品建设。                                                   |
| 插件打包与市场         | `utils/plugins/pluginLoader.ts:3009` 来源合并、`:3096` 完整加载、`:3137` 缓存启动、`:3155` 依赖校验；commands/agents/hooks/MCP/LSP/output styles 分别加载                    | 现有技能目录及手工 ToolRegistry；Tauri 的 plugin-* 依赖是桌面框架插件，不是 Agent 插件系统                    | **missing**。先明确 manifest、组件注册和生命周期，市场、签名/策略、自动更新另立阶段。                                       |
| 配置分层与策略         | `utils/settings/settings.ts:645` 插件默认值与用户/项目/local/flag/policy 合并；`:836` 来源追踪；`changeDetector.ts` 监听；`settings/mdm` 受管设置                            | `services/settings.ts` 单个 SQLite 设置文档，Zod 校验；`config.ts` 支持 env 优先级                            | **partial**。个人产品先补工作区覆盖和来源诊断；企业远程策略/MDM 不是当前必需项。                                            |
| 云端/远程会话          | `bridge/remoteBridgeCore.ts:140` 初始化、鉴权刷新、双向控制；`remote/RemoteSessionManager.ts:95` WebSocket 消息+HTTP 提交+审批关联；`server/directConnectManager.ts:40` 直连 | `http/routes/cli-monitor.ts:17` 只代理本机、校验实例身份；编码现场可观察本地 CLI                              | **partial**。本机跨端能力已具备；跨设备网络、重连、授权和消息去重仍缺。不要把监听 localhost 改成 0.0.0.0 当成完整远程功能。 |
| IDE 与 LSP             | `utils/ide.ts:1288` IDE 发现连接；`services/lsp/manager.ts:63` 初始化状态；`LSPServerManager.ts` 实例管理；`passiveFeedback.ts` 将诊断送入工作流                             | `projects.open` 可启动 Cursor，原生工具可搜索/读写；无 LSP 生命周期和诊断流                                   | **partial**。打开编辑器与语义诊断不同，后续可优先将 TypeScript diagnostics 接入编码验证。                                   |
| 浏览器/桌面控制        | `utils/claudeInChrome` 浏览器原生宿主/MCP；`utils/computerUse` macOS 适配、输入、锁和退出                                                                                    | `packages/integrations/src/browser/actions.ts:29` Playwright 操作，`:88` 文本快照；BrowserService 管登录态    | **partial，已有实用能力**。已有浏览器自动化；系统级 Computer Use 与浏览器扩展连接仍缺，可按实际场景选择。                   |
| Shell 隔离             | `utils/sandbox/sandbox-adapter.ts:172` 把文件/网络策略转换为 sandbox-runtime 配置，`:704` 包装命令，`:730` 初始化；bash/PowerShell 解析模块另见核心报告                      | `integrations/src/exec.ts:35` 原生进程执行；`agents/tools.ts:432` 审批。fs 工具路径约束不能替代 shell OS 沙箱 | **missing**。支持任意项目 shell 时是后续运行时工程；Windows 不能照搬 Unix sandbox 实现。                                    |
| 密钥与 Provider 认证   | `utils/auth.ts:1427` OAuth 更新；`utils/secureStorage/index.ts:9` macOS keychain、其他平台文本存储 fallback                                                                  | `apps/sidecar/src/secrets.ts:14` AES-256-GCM，Tauri 注入系统钥匙串主密钥，独立 sidecar 使用开发密钥文件       | **present，部分更适合 Windows**。应保留现有加密机制；OAuth/cloud provider refresh 属独立缺口，不能机械照抄文本存储。        |
| 调度与后台作业         | `utils/cronScheduler.ts`、`cronTasks.ts`、`skills/bundled/loop.ts`、`scheduleRemoteAgents.ts`                                                                                | `services/scheduler.ts:15` 每日热榜及定时 workflow；任务运行/事件已有持久化                                   | **partial**。不是没有调度；缺会话内通用 cron/loop 与远程调度控制。                                                          |
| 发布、诊断、遥测       | nativeInstaller、autoUpdater、doctorDiagnostic、telemetry、profilers、startupProfiler                                                                                        | CLI 生命周期、版本/build、桌面 updater 已有；缺统一运行时诊断、启动性能和费用遥测                             | **partial**。先构建公开诊断状态；Anthropic 专属上报、订阅计费、企业端点不应照搬。                                           |

## 分管目录清单

| 目录          | 文件数 |    行数 | 作用及阅读层级                                                                                                       |
| ------------- | -----: | ------: | -------------------------------------------------------------------------------------------------------------------- |
| bootstrap     |      1 |   1,758 | 会话/CWD/权限/功能状态单例，结构扫描                                                                                 |
| bridge        |     31 |  12,613 | 双向远程桥、消息、JWT、轮询、权限；深入 `remoteBridgeCore.ts`                                                        |
| constants     |     21 |   2,648 | API/工具限制、产品与模型常量、提示片段；完整导出扫描                                                                 |
| entrypoints   |      8 |   4,052 | CLI/MCP/SDK/schema 启动；入口和 SDK 事件目录分析                                                                     |
| hooks         |    104 |  19,232 | 主要是 React hooks：输入、权限、队列、IDE、远程、文件/技能变化、通知；完整目录/导出扫描，与运行时 `utils/hooks` 区分 |
| migrations    |     11 |     603 | 配置键迁移、模型别名迁移；完整职责扫描                                                                               |
| moreright     |      1 |      26 | internal-only 功能的外部 stub，不作为功能缺口要求                                                                    |
| native-ts     |      4 |   4,081 | color-diff、file-index、Yoga 的 TS 移植；API/头注释分析                                                              |
| plugins       |      2 |     182 | 内置插件注册；核心实现另在 utils/plugins                                                                             |
| remote        |      4 |   1,127 | 远程消息和权限适配、WebSocket；深入 manager                                                                          |
| server        |      3 |     358 | direct connect session、连接控制；深入 manager                                                                       |
| skills        |     20 |   4,066 | loader、MCP skills、内置技能；深入 loader                                                                            |
| upstreamproxy |      2 |     740 | 云容器 CONNECT→WebSocket 代理和 CA/令牌启动；入口分析，不适用于本机默认运行                                          |
| utils         |    564 | 180,487 | 下表全部子域；关键路径深入阅读                                                                                       |
| setup.ts      |      1 |     477 | 运行环境/项目初始化与清理注册，入口扫描                                                                              |

`utils` 没有当成“杂项”略过，完整子域映射如下。顶层 298 文件包括 API、认证、项目指令、会话恢复/存储、文件历史、输入处理、工具结果存储、worktree、上下文和诊断等，跨域核心深读由三份报告共享。

| 子域              | 文件数 | 主要能力                                                                    |
| ----------------- | -----: | --------------------------------------------------------------------------- |
| 顶层              |    298 | 通用 API/认证/会话/上下文/文件/工具辅助；深读 claudemd、hooks、auth、ide 等 |
| background        |      2 | 后台远程会话与前置条件                                                      |
| bash              |     23 | AST、前缀提取、管道、引号、heredoc、命令 spec                               |
| claudeInChrome    |      7 | Chrome 原生消息、MCP、提示与展示                                            |
| computerUse       |     15 | 系统输入、macOS adapter、控制锁、清理                                       |
| deepLink          |      6 | 协议解析、注册、终端启动与提示                                              |
| dxt               |      2 | 扩展 ZIP 工具                                                               |
| filePersistence   |      2 | 输出文件保留与扫描                                                          |
| git / github      |  3 / 1 | Git 配置/文件系统/ignore，gh 登录检查                                       |
| hooks             |     17 | Hook command/HTTP/prompt/agent 执行、事件、配置和技能注册                   |
| mcp               |      2 | elicitation 验证、日期时间参数                                              |
| memory / messages |  2 / 2 | 记忆版本与类型、消息映射和初始化                                            |
| model             |     16 | 模型别名、能力、上下文、供应商与弃用                                        |
| nativeInstaller   |      5 | 下载、安装、包管理器和 PID 锁                                               |
| permissions       |     24 | 权限模式、规则解释/合并、路径、命令分类                                     |
| plugins           |     44 | marketplace、安装缓存、依赖、内容加载、策略、刷新                           |
| powershell        |      3 | PowerShell AST/前缀/危险 cmdlet                                             |
| processUserInput  |      4 | bash/slash/text 输入分派                                                    |
| sandbox           |      2 | OS sandbox 配置适配、UI 状态                                                |
| secureStorage     |      6 | keychain 与 fallback                                                        |
| settings          |     19 | 分层配置、策略来源、MDM、校验与热更新                                       |
| shell             |     10 | Bash/PowerShell provider、只读判断、输出限制                                |
| skills            |      1 | 技能文件变更监听与缓存失效                                                  |
| suggestions       |      5 | 命令、目录、历史、技能、Slack 补全                                          |
| swarm             |     22 | tmux/iTerm/进程内后端、权限同步、重连、布局                                 |
| task              |      5 | 后台任务框架、磁盘输出与 SDK 进度                                           |
| telemetry         |      9 | 日志、tracing、Perfetto、插件/技能事件                                      |
| teleport          |      4 | 远程环境选择、API、Git bundle                                               |
| todo / ultraplan  |  1 / 2 | Todo 类型、远程计划会话与关键词入口                                         |

## 建议本轮优先实现的三个有界缺口

1. **标准技能字段兼容**：兼容 `allowed-tools` 与现有 `allowed_tools`，对字符串/数组作明确归一化；支持 `disable-model-invocation` 与 `user-invocable` 时，要同时约束自动目录、trigger 激活、`skills.load` 和显式用户调用。`allowedTools` 当前只是返回给模型的元数据，不是已执行的权限边界，不能把“解析成功”写成“沙箱已限制”。验证现有技能保持兼容、禁止自动调用的技能不被 trigger 注入、不受支持字段可诊断。
2. **工作区项目指令**：将注册项目的 `AGENTS.md`/`CLAUDE.md` 等允许来源在发起运行时读入，记录来源、长度限额、去重、缺失/读取失败；并传给 specialist。AgentDesk 是多项目常驻 sidecar，不应照搬 Claude 的进程全局 cwd/cache；每个 Run 必须带工作区，避免项目 A 指令污染项目 B。嵌套目录规则可作为第二阶段按访问路径加载。
3. **技能显式刷新和诊断**：先提供刷新 API/工作台动作，原子替换 registry snapshot，处理删除和重复名称；错误条目保留可解释诊断，运行中任务使用已取得快照。比一开始引入多目录 watcher 更容易验证，之后再加 debounce watcher。

MCP、LSP、可执行 Hooks、插件市场、OS 沙箱和跨设备远程均需新增运行时/持久化/生命周期，应该进入可验收的独立迭代。它们是已确认差距，不应在只完成 UI、文件工具和技能字段后宣称“已与 Claude Code 全面对齐”。

## 复用方式

借鉴接口边界、状态机、来源优先级、重连/超时/取消和缓存失效策略；继续使用本项目既有 TypeScript、Zod、ToolRegistry、Task/Run 和事件协议。没有复制这份参考源码的实现。用户提供的代码中包含 Anthropic 专属环境、订阅、企业策略、遥测和未启用功能，这些应按本产品需求选择，而非逐项复制。
