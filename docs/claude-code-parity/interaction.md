# Claude Code 2.1.87：终端交互与会话能力对照

分析日期：2026-10-28。参考根目录：`D:/AI code/claude-code-2.1.87/claude-code-2.1.87/src`。本文中的 Claude 路径均相对于该目录。AgentDesk 依据是本次修改中的工作区，而非某个发布版；CLI 的 `.mjs/.jsx` 文件名为迁移前名称，迁移后对应 `.ts/.tsx`。

## 覆盖范围与证据边界

本方向对下表全部 **749 个文件**进行文件枚举、全文读取后的结构扫描、导出符号提取、功能开关与 stub 识别。已进一步阅读启动渲染、命令路由、输入、恢复、回退、权限和消息呈现的关键实现及调用关系。**全文件扫描不等于每个文件逐行完成语义审计**；本报告不能代表已经验证该参考包能完整构建运行，也不能把受功能开关、账户或内部服务限制的功能视为默认可用。

文件级记录见 [interaction-inventory.json](interaction-inventory.json)。记录包含相对路径、行数、导出符号、功能开关、stub 标记、内嵌 source map 情况。扫描总计 158,877 行（移除单行 source map）；455 个文件具有内嵌 source map，已解码其中 `sourcesContent` 做结构复核，以免把 React Compiler 生成的缓存分支误认为原始设计。

| 范围           | 文件数 | 已识别的职责                                                                                                                                        |
| -------------- | -----: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components`   |    389 | 欢迎区、输入、消息、工具、审批、Diff、任务、Agent、扩展和设置组件                                                                                   |
| `commands`     |    207 | 本地命令、交互式命令、提示词命令及插件入口；其中 18 个文件是隐藏 stub                                                                               |
| `cli`          |     19 | 无界面运行、结构化输入输出、远程传输、管理命令、退出和更新                                                                                          |
| `screens`      |      3 | REPL、会话恢复、诊断                                                                                                                                |
| `ink`          |     96 | 自有终端渲染、键盘与粘贴解析、滚动、焦点、选择、布局、屏幕更新                                                                                      |
| `keybindings`  |     14 | 默认键位、上下文路由、自定义覆盖、冲突校验、快捷键提示                                                                                              |
| `vim`          |      5 | 模式转换、移动、操作符、文本对象及类型                                                                                                              |
| `voice`        |      1 | 语音的功能开关与账户能力检查；录音链路还依赖其他目录                                                                                                |
| `buddy`        |      6 | 独立于启动 Logo 的伴随角色、精灵、提示与通知                                                                                                        |
| `outputStyles` |      1 | 从项目和用户目录载入输出风格                                                                                                                        |
| 根目录指定入口 |      8 | `commands.ts`、`dialogLaunchers.tsx`、`history.ts`、`ink.ts`、`interactiveHelpers.tsx`、`main.tsx`、`replLauncher.tsx`、`projectOnboardingState.ts` |

`components` 的全部子组均已纳入清单：根组件、agents、ClaudeCodeHint、CustomSelect、design-system、DesktopUpsell、diff、FeedbackSurvey、grove、HelpV2、HighlightedCode、hooks、LogoV2、LspRecommendation、ManagedSettingsSecurityDialog、mcp、memory、messages、Passes、permissions、PromptInput、sandbox、Settings、shell、skills、Spinner、StructuredDiff、tasks、teams、TrustDialog、ui、wizard。没有只挑聊天页而跳过设置和扩展界面。

18 个 stub 位于 `commands/{ant-trace,autofix-pr,backfill-sessions,break-cache,bughunter,ctx_viz,debug-tool-call,env,good-claude,issue,mock-limits,oauth-refresh,onboarding,perf-issue,reset-limits,share,summary,teleport}/index.js`，内容仅为禁用且隐藏的占位命令。它们不构成可移植的功能实现。`commands.ts:225` 还明确列出内部命令，`commands.ts:476` 会按 availability 和 `isEnabled` 过滤可见命令。

## 主要结论

Claude Code 的交互优势来自几个相互配合的机制：单一稳定的消息视图、按工具类型展示的输出和审批、输入命令与模型提示的分流、会话和文件快照的联合恢复、明确的键盘上下文。专属角色图像只是其中一层。

AgentDesk 已有可工作的本地 Agent 工具、流式事件、历史会话、任务与子运行、审批、桌面编码现场和真实 Diff。当前差距主要在日常输入效率、会话控制、跨端审批的一致性、上下文可见性，以及编辑后的可恢复性。终端和桌面应共享执行事件与状态，不需要照搬 Claude 的整套终端渲染器。

## 功能对照

状态定义：**已有**表示对应主流程存在；**部分**表示有基础能力但行为或入口不完整；**缺失**表示本次检查未发现可用的对应流程；**不直接对齐**表示依赖 Claude 商业账户、内部服务，或不是当前编码体验的必要能力。

| 能力                               | Claude 实现依据                                                                                                                                              | AgentDesk 实现依据                                                                               | 结论与差距                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 专属形象与启动信息                 | `components/LogoV2/Clawd.tsx:5`、`CondensedLogo.tsx:20`：角色、模型、版本、目录，按终端宽度截断                                                              | `apps/cli/src/interactive/Welcome.jsx`；`apps/desktop/src/components/AgentMascot.tsx`            | **部分**。已经有自己的形象；需要稳定挂载、窄终端适配，不宜把模型品牌图标当作 Agent 身份                            |
| 稳定欢迎区与滚动记录               | `components/Messages.tsx:48` 将 Logo 子树隔离；`components/OffscreenFreeze.tsx:11` 解释滚出可视区后冻结的原因                                                | `apps/cli/src/interactive/App.jsx` 的 picker 和 chat 各自渲染 Welcome                            | **部分，含明确缺陷**。初次静态输出后切换选择器和聊天会重建欢迎区；稳定单一根节点可以修复，不能靠隐藏第二个图标处理 |
| 输入历史和历史搜索                 | `history.ts:145`、`:190`、`:411`；`components/HistorySearchDialog.tsx:84`；`keybindings/defaultBindings.ts:49`                                               | `InputBar.jsx` 仅绑定受控 `ink-text-input`；会话选择器不等于输入历史                             | **缺失**。需要 ↑/↓ 草稿恢复及 Ctrl+R；不能让上下键同时触发步骤导航                                                 |
| 多行编辑、粘贴折叠、输入撤销       | `components/PromptInput/PromptInput.tsx:1201` 清理 ANSI 并保存长粘贴；`:1660` 注册撤销、换行、外部编辑器和 stash                                             | CLI 是基础输入；桌面 `Composer.tsx` 支持 textarea 和 Shift+Enter                                 | **部分**。CLI 缺少完整编辑体验；可先实现多行和历史，再考虑编辑器与 stash                                           |
| 图片输入及剪贴板附件               | `PromptInput.tsx:1619`；`keybindings/defaultBindings.ts:14` 为 Windows 使用 Alt+V                                                                            | CLI 和桌面聊天正文目前均以字符串提交                                                             | **缺失**。不能仅做上传按钮，还需要共享消息契约、模型适配和持久化                                                   |
| 本地斜杠命令与自动补全             | `commands.ts:258`、`:476`、`:688`；`components/HelpV2/Commands.tsx:17`                                                                                       | CLI App 的 submit 直接 POST `/chat`；`args.mjs` 提供的是进程启动命令                             | **缺失**。先支持 `/help`、`/new`、`/resume`，将本地操作与送给模型的文本分开                                        |
| Shell 输入模式                     | `components/PromptInput/inputModes.ts:18` 将 `!` 前缀识别为 bash 模式                                                                                        | Agent 可调用 shell 工具，终端没有独立输入模式                                                    | **部分**。有工具执行能力，没有直接命令模式；新增时必须使用已有权限和输出事件链路                                   |
| 历史会话恢复                       | `screens/ResumeConversation.tsx:178` 恢复消息、成本、Agent、工作目录和文件历史                                                                               | `ConversationPicker.jsx`、App 的 `RESUME` 和 `session.mjs` 历史加载                              | **部分**。可以恢复消息；缺少完整执行上下文和文件快照恢复                                                           |
| 会话搜索、预览、重命名、标签和分支 | `components/LogSelector.tsx:71` 内容搜索；`commands/branch/branch.ts:222`；`commands/rename`、`commands/tag`                                                 | 启动时会话列表；桌面会话侧栏；任务 followup/resume                                               | **部分**。会话列表和任务重跑不能代替从历史节点创建分支                                                             |
| 会话与代码回退                     | `components/MessageSelector.tsx:31` 区分 both/conversation/code/summarize；`:177` 分别处理代码和会话恢复错误；`screens/REPL.tsx:4912` 调用 fileHistoryRewind | 有 Diff/变更产物，未发现消息级 checkpoint 与回退 API                                             | **缺失**。须先有文件快照、编辑归属和冲突检测，再增加回退界面                                                       |
| 会话导出与复制                     | `commands/export/index.ts:5`、`commands/copy`                                                                                                                | 未发现对应 CLI 会话操作；普通终端可手动复制                                                      | **缺失**。可直接复用持久化消息做 Markdown/JSON 导出，不依赖模型                                                    |
| 流式文本、工具状态、错误           | `components/messages`、`components/MessageRow.tsx`                                                                                                           | `chat-reducer.mjs`、`LiveTurnView.jsx`、`StepRow.jsx`；桌面 `useChatStream.ts`                   | **已有**，但信息结构仍可提升；应区分工具开始、输出、结束和失败                                                     |
| 合并读文件与搜索步骤               | `components/Messages.tsx:520` 合并 read/search、hook 与后台通知；`CollapsedReadSearchContent.tsx`                                                            | `StepList.jsx` 有折叠步骤与焦点展开                                                              | **部分**。现有逐工具卡片；还没有连续同类操作的摘要分组                                                             |
| 实际代码 Diff 与每轮修改           | `components/StructuredDiff.tsx:95`；`commands/diff/index.ts` 支持未提交变化与按轮次 Diff                                                                     | `features/code/DiffView.tsx`、`activity.ts`；共享 `FileChange` 事件                              | **部分**。桌面已有真实 Diff，CLI 主要仍显示工具卡片；可按文件聚合变更并跳转到编码现场                              |
| 工具特定的审批内容                 | `components/permissions/PermissionRequest.tsx:47` 按工具选择界面；`FilePermissionDialog` 预览文件差异并允许权限更新                                          | `ApprovalCard.jsx`、桌面 `Steps.tsx` 通用标题/详情和批准/拒绝                                    | **部分**。文件差异、shell 命令、拒绝原因及持久规则的呈现不够完整                                                   |
| 向用户提问                         | `components/permissions/AskUserQuestionPermissionRequest` 支持问题选项、自由输入和答案结构                                                                   | 后端 `tasks.ask_user`；`services/approvals.ts:92` 的 answer；编码现场 `CodePage.tsx:73` 文本回答 | **部分**。编码现场支持；CLI 和普通聊天仍主要将其当 y/n 审批，不能满足真实问答                                      |
| 跨端审批及中断                     | Claude 权限请求通过状态队列、回调及远程控制响应分离处理；`cli/structuredIO.ts` 接收控制响应                                                                  | App 有跨端轮询；TaskView 在 SSE 回调等待本地 y/n                                                 | **部分，含明确缺陷**。TaskView 在桌面批准后可能继续等本地输入；待审批分支也吞掉 Ctrl+C                             |
| 任务、子 Agent 和后台状态          | `components/tasks`、`components/teams`、`Spinner/TeammateSpinnerTree.tsx`                                                                                    | `task-reducer.mjs`、`RunView.jsx`；编码现场任务列表和事件时间线                                  | **部分**。已有任务/子运行，不等于完整可选中、发消息、停止的 Agent 团队和后台 shell 管理                            |
| 执行中追加输入与队列               | `PromptInput/PromptInputQueuedCommands.tsx`；`PromptInput.tsx:1256` 可取回排队消息编辑                                                                       | CLI InputBar 在 busy 时禁用；桌面 Composer 不允许 streaming 时发送                               | **缺失**。需要区分排队下一轮与中途 steering，避免并发污染同一会话                                                  |
| 模型选择和推理强度                 | `commands/model`、`commands/effort`、`components/ModelPicker.tsx`                                                                                            | ProvidersTab、BindingsTab、Composer 中 Agent 选择                                                | **部分**。已有多供应商绑定；没有会话内即时模型/effort 切换入口                                                     |
| Token、费用、上下文余量            | `components/TokenWarning.tsx:87`、`StatusLine.tsx:10`；`commands/context`、`commands/cost`                                                                   | StatusBar 显示忙闲、会话、待审批；没有对应上下文仪表                                             | **缺失**。应先从模型层产生可核实 usage，避免用字符数冒充实际 token                                                 |
| 清空与上下文压缩                   | `commands/clear/clear.ts`；`commands/compact/compact.ts:46` 使用正式 compact 结果和边界                                                                      | 未发现 CLI 本地会话命令；Agent 核心压缩能力由内核报告核对                                        | **缺失交互入口**。清空 UI、创建会话、压缩上下文应是三个独立动作                                                    |
| 自定义键位与 Vim                   | `keybindings/defaultBindings.ts:33`、`resolver.ts`、`loadUserBindings.ts`；`vim/transitions.ts:59`                                                           | useInput 直接处理 Ctrl+C、Ctrl+O、Tab 等固定按键                                                 | **部分**。有快捷键，无配置、作用域解析与 Vim；优先保持不抢正常输入                                                 |
| 终端搜索、虚拟滚动与鼠标选择       | `components/VirtualMessageList.tsx:289`；`ink/components/ScrollBox.tsx`、`ink/selection.ts`                                                                  | 上游 Ink 8 + Static 输出                                                                         | **缺失对应自有机制**，但不建议为对齐立即复制 96 个渲染器文件；优先真实终端回归、输出上限与稳定布局                 |
| 无界面运行和结构化协议             | `cli/print.ts:455`、`cli/structuredIO.ts:135`：恢复、流式 JSON、控制请求等                                                                                   | CLI `commands.mjs` 支持 JSON、SSE、tasks/inspect/resume，后端 HTTP 事件 API                      | **部分**。已有自动化接口；不是与 Claude SDK 兼容的双向协议，也不必强行兼容私有协议                                 |
| 设置、诊断、初始化                 | `screens/Doctor.tsx`、`interactiveHelpers.tsx:104`、`commands/config`                                                                                        | CLI init/doctor/service；桌面 Settings、Projects、Bindings                                       | **已有基础能力**。可补项目就绪状态与集中故障入口，无需重建已有页面                                                 |
| MCP、Hooks、Skills、插件管理 UI    | `components/mcp`、`components/hooks`、`components/skills`、`commands/plugin`                                                                                 | 桌面 SkillsPage 已有技能管理；其他后端能力见扩展报告                                             | **部分**。技能列表不等价于插件市场、MCP 连接管理和 Hook 生命周期                                                   |
| 输出风格                           | `outputStyles/loadOutputStylesDir.ts:29` 从项目/用户 Markdown 载入，支持优先级与缓存刷新                                                                     | 角色提示词与 Agent 定义存在，没有对应用户可切换风格目录                                          | **缺失独立能力**。可将风格作为配置层而非额外 Agent                                                                 |
| 语音输入                           | `voice/voiceModeEnabled.ts:31` 明确需要 Anthropic OAuth 和 claude.ai voice_stream                                                                            | 无对应语音输入                                                                                   | **不直接对齐原实现**。产品需要时接入自己的语音服务；不能复制账户检查就认为支持语音                                 |
| 伴随角色与商业入口                 | `buddy/companion.ts:107`、`CompanionSprite.tsx:176`；LogoV2 中 Passes/Overage                                                                                | 自有 AgentMascot；无 Claude 订阅、赠送额度等入口                                                 | Buddy 是**可选差异化功能**；商业与内部账户界面**不直接对齐**                                                       |

## 可以直接借鉴的实现原则

1. **把终端布局作为状态机处理。** 欢迎区、会话选择、聊天、审批、错误应在稳定根节点下切换；静态消息只追加已经结束的内容。Claude 的 OffscreenFreeze 还说明进入 scrollback 的内容不能继续因计时器或模型变化反复改写。AgentDesk 使用上游 Ink 时先遵循这个原则，不直接移植其私有渲染扩展。
2. **本地命令先解析，再决定是否调用模型。** Claude 将命令分为 local、local-jsx、prompt，并对远程输入分别过滤。AgentDesk 可先建立小型 typed registry，包含命令名、描述、参数处理、busy 时是否可用。`/help` 或 `/resume` 不应变成模型请求。
3. **审批不应冻结事件接收器。** UI 等待的是用户决定，事件订阅仍应能收到其他端的处理结果、错误和运行结束。共享审批状态比在每个 SSE callback 里等待一个本地 Promise 更容易保持一致。
4. **问答与批准是不同交互。** 后端已经有 question 类型，终端也应展示回答输入；不能向一个要求文本答案的任务只提交 `approved: true`。
5. **代码回退要由执行数据支持。** Claude 区分代码回退、会话回退和两者都回退，还分别显示失败。AgentDesk 需要将基线快照、写后 hash、操作归属、回退冲突和事件记录实现完整，不能拿 `git reset` 替代单轮 Agent 编辑回退。
6. **能力可用性必须显式判定。** 参考代码中的 `feature(...)`、availability、isEnabled 和账户检查决定某项功能是否真实启用。对齐清单应基于可运行能力，不能依据文件名堆功能。

## 建议本轮落实的三个有界改进

### 1. 欢迎区单次输出与会话切换

保留单一欢迎区/静态历史树，先等待历史列表确定再显示可交互输入，或确保历史加载只替换动态区域。测试要观察真实终端累计写入，至少覆盖无历史、异步出现历史、选择新会话、恢复旧会话，不能仅断言最后一帧中包含标题。

### 2. TaskView 审批同步和 Ctrl+C

复用 App 已有的跨端同步逻辑并抽离类型明确的审批处理。Ctrl+C 先于 pending 分支处理；退出等待时解除 Promise 和订阅；远端批准后不得再次发起相反决定。任务视图退出仍只断开跟随，保持现有“显式 cancel 才取消后端任务”的语义。加入远端批准、远端拒绝、待审批退出三个回归。

### 3. 最小本地命令与历史入口

支持 `/help`、`/new`、`/resume`，显示当前可用命令。只有确实需要模型处理的普通文本才 POST `/chat`。busy 状态明确提示不允许切换会话，不静默丢弃用户输入。之后再扩展 `/model`、`/context`、`/compact`、`/diff` 和历史搜索。

更大工程应独立落地：checkpoint/rewind、输入队列与 steering、多模态附件、跨目录会话搜索、终端虚拟列表、可配置键位和 Vim。它们有明确价值，但不能在一次迁移中仅增加外观入口并宣称已完整对齐。

## 验证状态

本方向只新增分析报告和文件级清单，没有修改业务源码，没有运行参考代码。结论来自静态扫描和关键实现阅读；运行行为由主任务中的回归测试、类型检查、构建和真实终端 smoke 验证。工作区正在并行迁移，因此最终交付报告应根据实现结果更新“本轮已完成”和“后续缺口”，不要把这里的建议当作已经实现的功能。
