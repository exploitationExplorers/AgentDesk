# Claude Code 2.1.87：执行内核、工具与上下文对照

分析日期：2026-10-28。参考目录：`D:/AI code/claude-code-2.1.87/claude-code-2.1.87/src`。下文参考路径均相对此目录，AgentDesk 路径相对项目根目录。状态描述的是本轮分析时的工作区，包括此前已实现但尚未提交的原生文件编辑与编码现场功能；后续实施结果应以总报告为准。

AgentDesk 已有原生工具循环、模型备用切换、任务/子 Run、人工审批、计划产物、长期记忆和真实文件 diff。核心差距集中在工具执行顺序、长期上下文、权限粒度、文件操作恢复、后台进程与子 Agent 的可恢复生命周期，不能简单归纳为“尚无 Agent 能力”。

## 本轮已落实

下方功能表保留初始审计证据，以下改进已在随后实施，不能继续记为未修复：

- `AgentTool.isConcurrencySafe` 显式声明并发性，未声明默认串行；连续只读批最多 8 个并发，写操作形成顺序屏障，结果按模型调用顺序归并。使用 `Promise.allSettled` 等待批内收尾，取消或事件回调失败不会遗留尚未等待的并发调用，也不会启动后续写入。已给明确只读的文件、列表和检索工具标记，动态 Shell/委派默认串行。
- Shell 分类改为受限参数组合；`git branch -D/-m/--set-upstream-to`、创建分支、`git fetch`、`--output`、外部 diff/textconv、未知标志和 shell 展开/控制字符进入原审批路径。此改进不等于 OS 沙箱。
- `claude.run` 描述改为用户明确选择外部 Claude 时调用，普通编码优先原生文件与 Shell 工具。
- 达到 `maxTurns` 后模型仍要求工具调用时，当前允许轮次的工具完成后明确抛出“任务尚未完成”的错误，保留已产生事件，不再开始下一轮；最后一轮正常回答仍成功。`maxTurns` 必须是正整数。这不会自动解决长任务续跑的上下文压缩问题。
- 新增 `services/project-instructions.ts`：每次运行加载已登记项目精确根下的 `AGENTS.md`、`CLAUDE.md`，来源随内容进入上下文。未读取祖先或用户全局规则。根续跑与子 Run 继承 workspace；CLI 聊天与工作台任务共用加载器并透传 specialist。无全局规则缓存，路径/junction 越界、二进制、读取失败、超过 32 KiB/文件或 64 KiB 总量会明确失败。
- 验证：agent-core 11 个测试通过；Shell 风险分类 47 个用例通过；项目指令、上下文隔离与继承、既有任务/方案/真实编码现场相关 33 个测试通过。agent-core 和 sidecar TypeScript 检查通过。

新增回归位于 `packages/agent-core/test/tool-scheduling.test.ts`、`apps/sidecar/test/shell-risk.test.ts`、`project-instructions.test.ts`、`project-context.test.ts`。

## 覆盖方法与边界

分管范围共 **376 个文件，121,455 行**。完整文件清单见 [core-inventory.json](./core-inventory.json)，逐文件记录路径、行数、顶层符号、条件功能开关。所有分管文件已被枚举并读取内容进行结构扫描；关键执行路径采用人工阅读实现与调用点的方式复核。这不是对 12 万行源码逐行人工审阅的声明，也不是对参考项目成功构建或运行的声明。

| 范围          | 文件数 |   行数 | 核对方式                                                                                                                   |
| ------------- | -----: | -----: | -------------------------------------------------------------------------------------------------------------------------- |
| `assistant`   |      1 |     87 | 会话历史入口与结构扫描                                                                                                     |
| `query`       |      4 |    652 | 查询配置、依赖注入、预算与停止 Hook                                                                                        |
| `tools`       |    184 | 50,863 | 全部工具族扫描；文件、Shell、Agent、计划、任务工具重点阅读                                                                 |
| `context`     |      9 |  1,013 | React 状态提供器与消息队列；不把它误当 LLM 上下文压缩模块                                                                  |
| `memdir`      |      8 |  1,736 | 项目记忆路径、入口限额、选择性召回                                                                                         |
| `tasks`       |     12 |  3,290 | 本地 Agent/Shell、远程 Agent、队友、停止与生命周期                                                                         |
| `coordinator` |      1 |    369 | 编排模式与条件开关                                                                                                         |
| `state`       |      6 |  1,191 | 全局状态、选择器、变更回调                                                                                                 |
| `services`    |    130 | 53,683 | 全目录扫描；执行、压缩、API、记忆重点阅读；MCP/LSP/插件由集成报告深读                                                      |
| `schemas`     |      1 |    222 | Hook 输入协议                                                                                                              |
| `types`       |     11 |  3,446 | 权限/Hook/插件等契约，包含生成类型                                                                                         |
| 指定根文件    |      9 |  4,903 | `query.ts`、`QueryEngine.ts`、`Task.ts`、`tasks.ts`、`Tool.ts`、`tools.ts`、`context.ts`、`cost-tracker.ts`、`costHook.ts` |

本地参考材料并不构成可直接构建的完整仓库。例如多处引用 `types/message.js`，但对应文件缺失。全量相对导入审计见集成报告的 `source-import-audit.json`。`feature(...)`、`USER_TYPE === 'ant'`、环境变量和远端配置会控制能力是否开放；源码里出现某个功能不等于普通用户运行该版本就能使用。

## 核心执行链

参考实现的大体路径是：`QueryEngine` 管理请求和会话 → `query` 循环组织模型上下文 → 结果预算/微压缩/自动压缩 → 流式模型请求 → 工具参数校验 → Hook 与权限判定 → 受控工具调度 → 结果进入对话 → 下一轮或停止。

关键证据：

- `query.ts:307` 使用持续查询循环；`query.ts:410` 起先做微压缩，再在约 `query.ts:461` 进入自动压缩，后续构造压缩后的消息。
- `services/tools/toolOrchestration.ts:19` 将连续可并发工具成组执行，非并发工具形成顺序屏障；`toolOrchestration.ts:91` 在参数解析成功后判定 `isConcurrencySafe`。
- `services/tools/StreamingToolExecutor.ts:40` 维护 `queued/executing/completed/yielded`，在模型工具块到达后调度，结果按收到的顺序归并，并单独交付进度。
- `services/tools/toolExecution.ts:599` 起先做 schema 与工具级输入校验，再进入权限/Hook/调用处理。
- `Tool.ts:362` 起把并发性、只读性、可中断性、进度、结果限额、权限和呈现能力放入统一工具契约。

AgentDesk 对应链路是 `ChatService/Task executor → Orchestrator → runAgent → executeToolCall → ToolRegistry`。这个分层适合保留；不需要为了复刻 Claude Code 将桌面端、服务端和 Ink UI 混成一个巨大进程。

## 功能对照

`已有` 表示主要能力存在，`部分` 表示场景覆盖或保证不同，`缺失` 表示此次对本项目相关模块的搜索未找到对应实现。此表不是相同可靠性的认证。

| 能力                      | Claude Code 实现依据                                                                    | AgentDesk 实现依据与差距                                                                           | 状态                   |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| 模型—工具多轮执行         | `query.ts:219`、`QueryEngine.ts:184`                                                    | `packages/agent-core/src/agent.ts:145` 已有工具循环和参数验证                                      | 已有                   |
| 工具执行顺序              | `services/tools/toolOrchestration.ts:26`，写操作独占；只读批并发                        | 分析时 `agent.ts:182` 对全部调用 `Promise.all`，没有操作级顺序屏障                                 | 部分，有明确修复项     |
| 模型流式输出              | `services/api/claude.ts`、`StreamingToolExecutor.ts`                                    | `agent.ts:92` 已转发文本增量；工具在整次模型响应完成后才执行，没有工具参数增量事件                 | 部分                   |
| 工具输出与执行现场        | `Tool.ts` 进度协议、`tasks/LocalShellTask`                                              | `tool_output/file_change`、Task event、编码现场和产物已存在                                        | 已有基础能力           |
| 重试和备用模型            | `services/api/withRetry.ts:180`，识别重试场景、取消、Retry-After                        | `agent.ts:96` 最多 2 次瞬时重试；仅尚未输出时切换候选，避免拼接两模型输出                          | 部分                   |
| 达到循环/输出限额后的状态 | `query.ts:1201` 输出 token 恢复；`AgentTool/runAgent.ts:782` 处理 max-turns 结果        | `agent.ts:161` 默认 12 轮，耗尽后直接 `agent_end` 返回，没有独立“未完成/轮次上限”结果              | 缺失                   |
| Token、费用与模型窗口     | `cost-tracker.ts:87/143/278`，会话恢复和用量累积                                        | `llm.ts:31` reasoning 关闭、窗口固定 128k、价格为 0；缺少真实 usage 持久化和预算约束               | 部分                   |
| 长会话压缩                | `services/compact/autoCompact.ts:72/241`、`compact.ts:387`                              | `conversation-store.ts:8` 只保留最后 20 条文本，无摘要、阈值和失败熔断                             | 缺失                   |
| 历史工具上下文            | `QueryEngine.ts`、`query.ts` 保留结构消息；压缩后按需恢复附件                           | `conversation-store.ts:15` 只附工具名，没有工具输入/结果的结构回放；更早目标可能丢失               | 部分                   |
| 长工具结果存储            | `Tool.ts` 的 `maxResultSizeChars`，`query.ts` 应用内容替换                              | `agent.ts:65` 对 JSON 文本截到 24k；原始字符串直接返回，超长日志仍可进入上下文，没有可检索文件引用 | 部分                   |
| 原生精确文件编辑          | `FileEditTool.ts:137/316/390`：先读、唯一匹配、写前再校验、生成 patch                   | `project-fs.ts:111` 已有唯一匹配、replaceAll、CRLF、逐文件排队、hash、真实 diff                    | 已有基础能力           |
| 强制先读与陈旧写防护      | `FileEditTool.ts:275/453` 校验会话读取状态，写前复核                                    | `project-fs.ts:56` 仅调用方提供 `expectedHash` 时校验；未提供仍可覆盖，没有会话读取账本            | 部分                   |
| 分段/多模态文件读取       | `FileReadTool.ts:227` 的 offset/limit/pages，图片/PDF/notebook 输出                     | `project-fs.ts:61` 仅整段 UTF-8 文本，超过 512 KB 拒绝，没有按行分页                               | 部分                   |
| 代码搜索                  | `GrepTool.ts:33` 正则、类型、上下文行、分页、multiline；Glob 使用高效搜索               | `project-fs.ts:175` 大小写不敏感子串，最多扫描 200 个文件且目录深度有上限                          | 部分                   |
| Notebook/LSP              | `NotebookEditTool.ts:90`、`tools/LSPTool`、`services/lsp`                               | 未找到 notebook cell 编辑、LSP 定义/引用/诊断接入                                                  | 缺失                   |
| 文件修改检查点与回退      | `FileEditTool.ts:426` 调 `fileHistoryTrackEdit`；写前备份                               | 已存 diff 产物，但没有对应磁盘快照、可检查的回退执行器和用户后续修改冲突判定                       | 缺失                   |
| Shell 执行                | `BashTool.tsx:229`，独立 PowerShell 工具                                                | `integrations/src/exec.ts:36` 可流式执行和取消，但使用系统 shell；Windows 默认并非 PowerShell 协议 | 部分                   |
| Shell 权限判定            | Bash/PowerShell 各自解析命令、标志、路径和危险行为                                      | `agents/tools.ts:39` 用宽泛前缀白名单，`git branch -D` 会被判安全，`git fetch` 也被列为只读        | 部分，有明确修复项     |
| 持久权限规则/模式         | `types/permissions.ts:16` 包含 default/acceptEdits/plan/dontAsk；规则有来源与目标作用域 | `agent-core/tools.ts` safe/confirm/dangerous + 单次审批；没有会话/项目粒度规则记忆与拒绝规则       | 部分                   |
| OS 层沙箱                 | BashTool 与 PowerShell 权限、sandbox adapter 联动                                       | 文件工具有根目录/junction 检查；`runShell` 是宿主进程，不构成 OS 文件/网络沙箱                     | 缺失                   |
| 工具生命周期 Hook         | `services/tools/toolHooks.ts`、`query/stopHooks.ts`、`schemas/hooks.ts`                 | 未找到可配置 PreToolUse/PostToolUse/Stop/UserPromptSubmit 生命周期系统；workflow 不是等价替代      | 缺失                   |
| 技能渐进加载              | `SkillTool/SkillTool.ts` 及路径触发                                                     | `agent-core/src/skills.ts:49` 已有目录摘要、触发词和 `skills.load`                                 | 已有基础能力           |
| 延迟工具发现              | `ToolSearchTool.ts:304`、`Tool.ts` shouldDefer/alwaysLoad                               | `ToolRegistry.select` 只有名称通配，每轮向模型提供选中工具的完整 schema                            | 缺失                   |
| 子 Agent                  | `AgentTool/runAgent.ts`、`loadAgentsDir.ts`、`resumeAgent.ts:42`                        | `orchestrator.ts:164` 能委派专用 Agent，子 Run 独立记录事件/审批；无动态角色定义和持久子会话继续   | 部分                   |
| 后台子进程/子 Agent       | `Task.ts:7` 多任务类型；Bash `run_in_background`、TaskOutput、TaskStop                  | TaskService 有并发队列和取消；Shell 工具仍同步等待结束，不能返回后台 handle 后继续主会话           | 部分                   |
| 多 Agent 通信与依赖图     | TeamCreate/SendMessage、`TaskUpdateTool.ts:33`                                          | 有 parentRunId 与委派回调；没有模型可用的 mailbox、队友状态或 blockedBy DAG                        | 部分                   |
| Worktree 隔离             | `EnterWorktreeTool.ts:55/80`，Agent isolation/worktree 恢复                             | 普通工具共用已登记项目根，未找到会话级独立 worktree 创建/恢复/清理能力                             | 缺失                   |
| 计划关口                  | EnterPlanMode、ExitPlanModeV2，权限上下文切换                                           | `task-executor.ts:141` 收紧只读工具；`tasks.ts:181` 强制方案审批关口；未做通用聊天模式切换         | 已有任务场景，聊天部分 |
| 用户澄清                  | `AskUserQuestionTool.tsx:62` 结构化问题和选项                                           | `agents/tools.ts` 的 tasks.ask_user 支持文本回答，复用审批存储，无多题/选项协议                    | 部分                   |
| 长期记忆                  | `memdir/memdir.ts:35` MEMORY.md 限额；`findRelevantMemories.ts:39` 选择性召回           | `MemoryService:188/211` FTS5/BM25 召回与自动提取，已有独立实现                                     | 已有基础能力           |
| 会话记忆与后台整理        | `services/SessionMemory/sessionMemory.ts`、`autoDream`、`extractMemories`               | 当前自动抽取稳定偏好/事实/决定，尚无会话滚动摘要、过时记忆整理和项目文件记忆索引                   | 部分                   |
| 定时执行                  | `ScheduleCronTool/CronCreateTool.ts:56`，受 AGENT_TRIGGERS 控制                         | AgentDesk scheduler/workflows 已有调度；没有对应模型可调用 cron CRUD 工具协议                      | 部分                   |
| Web 获取/搜索             | WebFetchTool、WebSearchTool                                                             | 有 web.fetch、浏览器、资讯搜索；未发现通用实时 Web 搜索 provider 工具                              | 部分                   |

## 工具族完整目录归类

184 个工具相关文件中的所有一级工具族均纳入以下归类；仅含提示词或常量的目录不会被视为完整实现。

| 工具域         | 本地源码目录                                                                                                                       | 对齐意义                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 文件与代码理解 | FileReadTool、FileEditTool、FileWriteTool、GlobTool、GrepTool、NotebookEditTool、LSPTool                                           | 优先保障编辑正确性、分段读取、可验证 diff，再建设 notebook/LSP                |
| 进程           | BashTool、PowerShellTool、TaskOutputTool、TaskStopTool                                                                             | 命令分类、后台 handle、持久日志、进程树取消                                   |
| 编排           | AgentTool、TeamCreateTool、TeamDeleteTool、SendMessageTool、shared                                                                 | 角色定义、独立上下文、子任务回传、worktree 隔离                               |
| 计划与任务     | EnterPlanModeTool、ExitPlanModeTool、AskUserQuestionTool、TodoWriteTool、TaskCreateTool、TaskGetTool、TaskListTool、TaskUpdateTool | 与已有 Task/Run/Artifact 合并，避免再造并行的任务数据库                       |
| 工作区         | EnterWorktreeTool、ExitWorktreeTool                                                                                                | 可恢复的独立仓库状态，与普通 cwd 区分                                         |
| 外部能力       | WebFetchTool、WebSearchTool、MCPTool、McpAuthTool、ListMcpResourcesTool、ReadMcpResourceTool、ToolSearchTool                       | MCP/LSP 的详细设计见扩展集成报告                                              |
| 扩展与配置     | SkillTool、ConfigTool                                                                                                              | 复用现有技能加载器；ConfigTool 包含内部环境限制                               |
| 调度与远端     | ScheduleCronTool、RemoteTriggerTool、BriefTool                                                                                     | 先核对环境/服务端依赖，不把内部能力当成可直接移植的通用功能                   |
| 实验与辅助     | REPLTool、SleepTool、SyntheticOutputTool、testing、根 utils.ts                                                                     | REPLTool/SleepTool 在本地主要为常量、提示或原语配置，不能据此判定完整运行能力 |

## 其余分管模块

- `assistant/sessionHistory.ts` 提供会话历史相关入口；`context` 的 9 个模块主要为队列、通知、模态层、语音和统计 React Context；`state` 是这些交互共享状态的存储与选择器。AgentDesk 桌面与 CLI 有不同 UI 状态容器，应对齐事件契约，不必照搬 React 全局单例。
- `coordinator/coordinatorMode.ts` 使用条件编译和运行模式改变工具池。AgentDesk 的固定专用 Agent 路由是较简单的等价方向，动态角色、上下文继承和协作控制另需设计。
- `services/api` 的 20 个文件涵盖模型请求、重试、usage、错误、上传以及商业服务 API。`services/analytics` 的 9 个文件是遥测、feature 配置和日志；额度、推荐奖励、组织政策不属于原生编码功能的必备对齐项。
- `services/compact` 的 11 个文件区分微压缩、整段摘要、压缩后清理、会话记忆快速恢复和阈值提示。这一层与 `memdir` 长期记忆不同，不能用已有 MemoryService 代替。
- `services/SessionMemory`、`extractMemories`、`autoDream`、`teamMemorySync` 分别处理会话笔记、提取、后台整理和团队同步；团队同步还包含 secretScanner/guard。部分能力受远端开关控制。
- `services/PromptSuggestion`、`AgentSummary`、`toolUseSummary`、`awaySummary`、`tips` 是提示建议与摘要呈现；`MagicDocs`、语音、notifier、preventSleep 是特定体验能力。它们可以独立排期，不应阻塞可靠的文件修改链路。
- `services/mcp`、`lsp`、`plugins`、`oauth`、`settingsSync`、`remoteManagedSettings` 的全部文件已纳入本清单，关键实现由本次扩展集成分析交叉复核；对应细节见该报告。
- `types/generated` 是生成的遥测/协议类型；`schemas/hooks.ts` 和 `types/hooks.ts` 则是 Hook 协议。生成类型不等于独立产品功能，也不需要机械迁移到 AgentDesk。

## 本轮优先修复建议

1. **为工具建立执行顺序屏障。** 在 `AgentTool` 契约中增加明确的并发属性，默认串行；仅给确认只读且互不干扰的工具声明并发。维持模型给出的顺序：连续只读批 → 写操作 → 后续只读批。审批安全等级和并发安全是两个维度，不能用 `risk === safe` 推导并发，因为 `memory.store`、`projects.scan`、`browser.close` 都有副作用。验证读读能重叠、写与任意相邻操作不重叠、结果仍按调用顺序归并、取消后不启动后续变更。
2. **收紧已知错误的 Shell 白名单。** 按子命令和参数形态判定，未知参数保守进入既有审批路径；至少修复 `git branch -D/-m/--set-upstream-to`、`git fetch` 与能写文件/执行程序的 `git diff/log/show` 参数。区分 Linux shell、cmd 和 PowerShell 的展开与分隔语法。测试风险判定即可，无需真实删除分支或写文件。不要声称一次白名单修复就提供了完整 OS 沙箱。
3. **统一原生编码提示和运行终态。** `agents/tools.ts` 中 `claude.run` 的描述仍要求“本地改文件优先”调用外部 Claude，与新的 code Agent 原生文件工具提示相冲突，应改为用户明确选择外部 Claude 时使用。下一步给循环上限、取消、工具失败后未收尾等情况增加明确终态，避免耗尽 12 轮后仍显示普通成功。

上述前三项是局部、可验证的改进。自动压缩、checkpoint/rewind、动态子 Agent、MCP 和后台进程是独立功能建设，应按验收标准逐项落地，不能在只改入口文案或事件类型后宣称全部对齐。

## 后续建设的验收标准

| 优先级 | 功能                  | 可观察验收标准                                                                                                                     |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| P1     | 保留目标的上下文压缩  | 历史超过当前 20 条后仍保留原始目标、明确约束、未完步骤；工具调用/结果配对完整；取消/摘要失败不损坏原始历史；按模型窗口预留输出预算 |
| P1     | 分段读取与搜索分页    | 大文件可按行读取；搜索返回截断标记及下一页能力；没有命中与扫描受限明确区分                                                         |
| P1     | 强制读取版本与检查点  | 写现存文件前有读取版本；外部修改后拒绝陈旧覆盖；回退前展示影响，用户后改内容不被静默覆盖                                           |
| P1     | 后台进程与子 Run 恢复 | 主会话可继续；后台输出可增量读取；终止能处理进程树；重启能识别失联任务；跨端显示相同状态                                           |
| P2     | Agent worktree 隔离   | 两个并发编码任务互不修改同一工作目录；恢复会话返回正确 worktree；有改动时不会自动删除                                              |
| P2     | 权限配置与 Hook       | 权限来源/作用域可追溯；拒绝规则优先；Hook 失败与取消有界；敏感输入不默认进入日志                                                   |
| P2     | LSP、动态工具与插件   | 能查询定义/引用并看到修改后诊断；按需加载 schema；插件注册、权限和禁用可以审查                                                     |

此次分析未运行参考项目，也未把参考代码复制进 AgentDesk。结论来自本地源码结构扫描和关键实现阅读；源码缺失、条件开关和外部服务依赖已作为能力判断的限制保留。
