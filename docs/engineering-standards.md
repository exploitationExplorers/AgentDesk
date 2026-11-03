# AgentDesk 工程规范

> 提炼自 Claude Code 的架构设计模式，用于指导 AgentDesk（`packages/agent-core` + `apps/sidecar` + `apps/desktop` + `apps/cli`）后续的代码重构与新功能开发。
> 最后整理日期：2026-11-02。

## 0. 文档定位与证据边界（请先读）

本规范的素材来自两类完全不同性质的来源，使用前必须分清楚：

1. **`anthropics/claude-code` 官方 GitHub 仓库**——核实后确认它**不包含产品源码**，只是发布/Issue 跟踪仓库（`README.md` 只有安装方式和数据政策，没有 `CONTRIBUTING.md`、没有 commit 规范、没有架构文档；`CLAUDE.md` 只是该仓库自己 CI 的安全护栏说明）。因此本规范**不存在"抄 Claude Code 官方贡献指南"**这件事，所有"源码级"结论都来自下面第二类来源。
2. **第三方逆向分析**——[`learn-claude-source`](https://nangongwentian-fe.github.io/learn-claude-source/) 网站对 Claude Code v2.1.88 编译产物的逆向整理（作者声明"仅用于学习研究目的"），以及本仓库 `docs/claude-code-parity/` 下 2026-10-28 对本地 Claude Code 2.1.87 参考源码（1,902 个文件、51 万行）做的逐文件结构扫描 + 关键路径人工阅读（精确到文件:行号）。**这两类都是二手整理，不是逐行语义审计，也不构成"证明某功能在官方发布版默认可用"。**

因此本文档的性质是：**从"可观察到的工业级 Agent 产品长什么样"中提炼出的、可迁移的设计模式和工程纪律**，不是对 Claude Code 源码的复制，也不是官方规范的转述。引用到 Claude Code 具体文件/行号的地方，都只是"这个模式在那个系统里长这样"的例证。

`docs/claude-code-parity/{README,core,interaction,integrations,discussion}.md` 是**本仓库自己代码**与上述参考材料的能力对照表（已有/部分/缺失），比本文档更具体、更新更频繁，是实际重构时的 backlog 来源；本文档只负责"规则"层，不重复那四份文件的逐项对照结论。**已知过期点**：`core.md` 判定"长会话压缩=缺失"，但 `apps/sidecar/src/services/conversation-context.ts` 现已实现分段摘要压缩（滚动摘要 + 预算裁剪 + 失败熔断）——说明代码演进快于文档，使用对照表时请先用 `git log`/`grep` 核实文件是否仍存在、行为是否仍如文档所述。

## 1. 核心设计理念

五条贯穿工业级 Agent 系统的核心认知（源自 `learn-claude-source` 概览页五点洞察，经适配）：

1. **Agent 的本质是 `while` 循环 + 工具调用**，其余复杂度（压缩、权限、流式、子代理……）都是叠加在这个循环之上的工程纪律，不是额外的"魔法"。对应 `packages/agent-core/src/agent.ts` 的 `runAgent`。
2. **一切皆 Tool**：文件读写、Shell、子代理委派、未来的 MCP 都应该是同一个 `Tool` 接口的实现，Agent Loop 本身不感知差异。
3. **权限是架构的第一等公民**，不是事后补的安全层——检查点必须在执行之前，默认值必须 fail-closed。
4. **上下文窗口是稀缺资源**，必须用分层策略主动管理，而不是放任增长后截断。
5. **异步生成器（`async function*`）是流式与可中断性的标准范式**，优于手写回调或轮询。

这些认知与 `~/.maestro/workflows/coding-philosophy.md` 中"数据结构优先""拥抱简单""增量推进"等通用原则是同一层面的补充，不冲突：前者是通用编码哲学，这里是 Agent 系统的领域特定补充。

## 2. 十条可迁移设计模式与落地规则

| #   | 模式                            | 解决的问题                                                      | AgentDesk 现状                                                                                                                                                                                                                                                                                                                                           | 落地建议                                                                                                                                                                                                             |
| --- | ------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **统一 Tool 接口**              | 新增能力（内置工具/子代理/未来的 MCP）不应改动 Agent Loop 本身  | `packages/agent-core/src/tools.ts:66` 已有 `AgentTool`/`defineTool`，`ToolRegistry.select` 支持命名空间通配                                                                                                                                                                                                                                              | 新工具一律通过同一接口注册；禁止在 `orchestrator.ts` 里为某个工具开特例分支                                                                                                                                          |
| 2   | **权限三态 + fail-closed**      | 二元 allow/deny 表达不了"需要询问"，且遗漏声明不能等于放行      | `agent.ts:309` 已有 safe/confirm/dangerous 三级 risk；`permission-rules.ts` 持久规则（2026-11-03 已扩展）支持任意工具 + `decision: allow\|deny`（deny 优先于 allow），当前覆盖 shell.run/fs.write/deploy.run 三个工具的 key 提取；仍**无项目/会话级 scope**（规则全局生效）、仍无 `ask` 决策（无规则命中即回退人工审批，语义上等价于 `ask`，未显式建模） | 新工具要支持"记住规则"需在 `permission-rules.ts` 的 `keyOf` 补一行 key 提取；若要按项目/会话隔离规则，再引入 `scope` 字段；新工具不声明风险等级时默认 `dangerous`（需要确认），不是默认 `safe`                       |
| 3   | **分层上下文压缩**              | 长任务会耗尽上下文窗口，直接截断会不可逆丢信息                  | `conversation-context.ts` 已有阈值触发的滚动摘要 + 预算裁剪 + 失败熔断                                                                                                                                                                                                                                                                                   | 补齐"每轮保留最近 N 条完整工具结果、更早替换为占位符"的 micro 层；摘要固定用结构化字段（目标/进度/决策/文件/错误/下一步），不要自由文本；压缩前先把原始转录落盘                                                      |
| 4   | **子代理即分治**                | 子任务的中间步骤不应污染/膨胀主任务上下文                       | `orchestrator.ts:164/180` 已支持委派专用 Agent，子 Run 有独立 `parentRunId` 和事件流                                                                                                                                                                                                                                                                     | 子代理必须从空消息列表起步；只回传最终产物（设大小上限）；子代理可用工具集中**绝不能包含"派生更多子代理"的工具**，防止递归爆炸；按任务类型裁剪工具集（最小权限）                                                     |
| 5   | **Hook 洋葱模型**               | 需要在不改源码的前提下，于工具调用前后插入审计/拦截/改写逻辑    | 目前只有单点审批（`approvals`），没有通用 Pre/PostToolUse 生命周期                                                                                                                                                                                                                                                                                       | 在 `executeToolCall` 前后引入可配置 hook 接口：Pre-hook 能 `block`/改写 input，Post-hook 能改写 result；顺序固定为 `validateInput → PreHook → checkPermissions → call() → PostHook`；先支持内置 hook，再考虑外部脚本 |
| 6   | **异步生成器驱动流式**          | 实时反馈、随时中断、生产者/消费者背压不应靠回调或轮询实现       | `agent.ts:126` 的 `stream()` + `emit` 回调；SSE 经 `run-events` → `task-sse.ts` 推到前端                                                                                                                                                                                                                                                                 | 新增流式链路优先用 `async function*` + `yield*`；中断统一走 `AbortSignal` 级联传播，不要新开一套取消机制                                                                                                             |
| 7   | **两层按需加载（目录 + 全文）** | 工具/技能数量增多时，系统提示词不能线性膨胀                     | `skills.ts` 已有目录摘要 + 触发词 + `skills.load` 按需加载技能全文                                                                                                                                                                                                                                                                                       | 工具数量变多后比照同一模式：核心工具（文件/Shell/委派）常驻，其余只发名称+简述，按需取完整 schema                                                                                                                    |
| 8   | **Append-only 持久化**          | 高频写入需要性能和 crash 安全（最坏只丢最后一行）               | `tasks.ts` 的 Task/Run/Artifact 状态机已用 SQLite；会话历史存储方式需核实是否整体重写                                                                                                                                                                                                                                                                    | 会话转录类数据优先 JSONL 追加写 + 元数据分文件，而不是整体重写单一 JSON；高频内存态只在退出/快照时落盘                                                                                                               |
| 9   | **Fail-closed 默认值**          | 开发者忘记声明安全属性时，"忘记写"不能等于"允许"                | 部分工具的并发/风险属性已显式声明                                                                                                                                                                                                                                                                                                                        | 所有新工具/规则引擎的默认分支统一走"拒绝/不安全/需要确认"，用集中的 `DEFAULTS` 常量显式表达，不要散落在各处的隐式 `?? true`                                                                                          |
| 10  | **适配器模式扩展外部能力**      | 未来接入 MCP 等外部协议时，不应为每个外部服务单独写一套分发逻辑 | 当前全仓库未发现 MCP 相关代码（已核实缺失）                                                                                                                                                                                                                                                                                                              | 若要接入 MCP：工具命名加来源前缀防冲突（如 `mcp__{server}__{tool}`）；单个外部连接失败要隔离、不拖垴整体；权限钩子内建"自动批准白名单 + 首次连接询问"两档                                                            |

> 以上"现状"列的文件:行号来自后台调研 agent 对当前代码的直接 Read/Grep 核实；重构前请用 `git log -p` 或重新 `grep` 复核，避免基于过期引用动手。

## 3. 目录结构规范

### 3.1 Monorepo 顶层约定（现状，继续保持）

```
AgentDesk/
├── apps/
│   ├── desktop/     # Tauri + React 桌面端 UI
│   ├── sidecar/     # Node/Hono 常驻后端：Agent 执行、HTTP/SSE API
│   └── cli/         # Ink 终端客户端
├── packages/
│   ├── agent-core/  # Agent Loop / Tool Registry / Orchestrator 核心库，不依赖具体 UI 或传输层
│   ├── shared/      # 跨包契约（Zod schema + 推导类型），任何包都可以依赖，不反向依赖业务包
│   ├── integrations/# 第三方能力适配（浏览器自动化等）
│   ├── ui/          # 可复用 UI 组件
│   └── workflow/    # 可视化工作流相关
├── docs/
│   ├── claude-code-parity/  # 能力对照 backlog（证据密集型，逐行引用）
│   └── engineering-standards.md  # 本文档：规则层
└── scripts/         # 构建/发布/校验脚本
```

依赖方向只能是 `apps/* → packages/*`、`packages/agent-core → packages/shared`，禁止 `packages/*` 反向依赖 `apps/*`；`packages/shared` 不依赖任何其他内部包。

### 3.2 新增能力时的标准落点（对应模式 #1/#7 的"一切皆 Tool"与"集中注册"）

| 要新增的东西      | 放在哪                                                                  | 必须同时做的事                                                  |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| 新的 Agent 工具   | `packages/agent-core/src/tools.ts`（定义）+ 具体实现放对应 service      | 声明 `isConcurrencySafe`/风险等级（fail-closed 默认值）；补单测 |
| 新的 HTTP 路由    | `apps/sidecar/src/http/routes/<domain>.ts`                              | 一路由一文件，禁止塞进 `app.ts`                                 |
| 新的跨包契约类型  | `packages/shared/src/contracts/<domain>.ts`，Zod schema 定义 + 类型推导 | 不要在业务包里重新定义等价类型                                  |
| 新的桌面页面/功能 | `apps/desktop/src/features/<feature>/`                                  | 按 feature 分目录，不按组件类型分目录                           |
| 新的技能          | 技能目录下 `SKILL.md`（frontmatter 声明 `name`/`description`/触发条件） | Markdown + frontmatter，不用 JSON                               |

### 3.3 命名约定（现状已遵循，继续保持）

- 文件名：TS/TSX 源文件 `kebab-case.ts`；React 组件文件可用 `PascalCase.tsx`（与组件名一致）。
- 类型/接口/Zod 推导类型：`PascalCase`；Zod schema 常量：与类型同名的 `camelCase`（如 `taskSchema` → `type Task`）。
- 函数/变量：`camelCase`；禁止用的变量名加前缀 `_`（已在 ESLint 规则中强制）。

## 4. TypeScript / 代码风格规范

### 4.1 现状（`tsconfig.base.json` / `eslint.config.js`，继续保持）

- `strict: true` + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noFallthroughCasesInSwitch` + `verbatimModuleSyntax`——**不允许放松这些**，它们是防止"遗漏声明=静默放行"（对应模式 #9 fail-closed）的类型系统保障。
- `@typescript-eslint/consistent-type-imports: error`：类型导入必须用 `import type`。
- `no-console`：只允许 `console.warn/error/info`，禁止裸 `console.log` 落入生产代码。
- React Hooks 规则仅在 `apps/desktop`、`apps/cli`、`packages/ui` 生效。

### 4.2 本规范新增的纪律（结合 Claude Code 模式提炼，供后续重构对照）

- **安全相关属性一律显式声明，不依赖默认值隐式放行**（模式 #9）：新工具/新权限规则如果没有显式写风险等级，CI/代码评审应视为缺陷，而不是"先跑着看"。
- **工具/服务函数是完整对象，不是裸函数**（模式 #1/#2）：新工具除了 `execute`，还要带 schema 校验、风险标注、结果大小上限；参考 `tools.ts:66` 的现有写法延伸，不要开辟第二套裸函数注册方式。
- **错误处理统一走 `AppError`/`ErrorCode`**（`@agentdesk/shared`）：HTTP 层由 `app.onError` 统一转 JSON + 状态码；工具执行层捕获异常转字符串结果返回给模型，而不是让异常冒泡到用户看到裸 stack trace。
- **注释解释"为什么"而非"是什么"**：现状已经这样做（如 Windows 路径大小写、符号链接防护的边界条件注释），继续保持，新代码不写"展示型"注释。
- **不写占位实现而不说明**：确实需要占位时要在代码中明确标注（如现有 `tasks.ts` 的 `placeholderExecutor` 写法），不要留"看起来实现了、其实是 stub"的函数。

## 5. Git 提交规范

项目已通过 `commitlint.config.js`（`@commitlint/config-conventional`）强制 Conventional Commits，`git log` 显示的历史也基本遵循"中文描述 + 英文 type/scope"的风格。本节把现状固化为明确规则：

### 5.1 格式

```
<type>(<scope>): <简短中文描述>

[可选正文：说明动机/背景，而不是复述 diff]
```

- `type` 取值：`feat` `fix` `refactor` `docs` `test` `chore`（与用户全局 `CLAUDE.md` 规范一致）。
- `scope` 建议用受影响的包/应用名：`desktop` `sidecar` `cli` `agent-core` `shared` `code`（编码工作台）`projects` 等，对应 `apps/*`、`packages/*` 目录名或子功能名。
- 描述用简体中文，动宾结构，不写"修改了 xx 文件"这类复述 diff 的话，而是说明做了什么/为什么。
- **反例**（历史上出现过一次，不要重复）：commit subject 直接是一段未解析的 JSON 字符串（如 `{"subject": "feat(projects): ..."}`）——说明生成 commit message 的脚本/AI 提交流程没有把结构化输出正确解包成纯文本，属于工具链缺陷，任何自动生成 commit message 的流程都要在写入前校验"最终字符串不包含 JSON 结构字符"。

### 5.2 示例

```
feat(agent-core): 为工具调用增加并发安全标注

只读工具默认允许并发批处理，写操作形成顺序屏障，避免 Promise.all 无差别并行导致的文件竞争。
```

```
fix(sidecar): 修复长会话压缩后工具调用与结果配对丢失的问题
```

### 5.3 提交粒度

- 一次提交只做一件事：规则变更（如本文档涉及的 ESLint/tsconfig 调整）与业务代码改动分开提交，便于单独回滚。
- 涉及"设计模式落地"类的重构（如补齐权限三态），提交信息里直接写清楚对应 `docs/engineering-standards.md` 的第几条模式，便于未来追溯动机。

## 6. Agent 专项规则 Checklist（重构时逐项核对）

> 这是"模式→规则"在具体任务上的检查单；每项都标注了现状差距来源（`docs/claude-code-parity/*.md`），动手前请先用 Grep/Read 核实差距是否依然存在。

- [x] 工具执行顺序：只读工具可并发，写操作是否已形成顺序屏障？——**2026-11-03 核实已修复**：`packages/agent-core/src/agent.ts` 已用 `toolCallBatches()` 按 `tools.ts:75` 的 `isConcurrencySafe` 字段分批，连续只读工具攒批 `Promise.allSettled`（上限 `MAX_CONCURRENT_TOOLS = 8`），一遇写操作立即 flush 并单独成批，批次间顺序 `await`；全仓库 `packages/agent-core/src` 已无裸 `Promise.all`。单测：`packages/agent-core/test/tool-scheduling.test.ts`。
- [x] Shell 风险分类：`git branch -D/-m`、`git fetch` 等是否仍被宽泛前缀白名单误判为安全？——**2026-11-03 核实已修复**：`apps/sidecar/src/agents/shell-policy.ts` 按子命令+参数级白名单判断（`GIT_READONLY_FLAGS` 等），非简单 `git` 前缀匹配；`branch` 白名单不含 `-D/--delete/-m`，`fetch` 根本不在只读表中，二者均判定为 `dangerous`。单测：`apps/sidecar/test/shell-risk.test.ts:39-84`（显式覆盖这三个命令）。
- [x] 权限规则是否仍只覆盖 `shell.run`，缺少 `fs.write`/`deploy.run` 等其他高风险工具的持久规则？——**2026-11-03 核实后已修复**：`PermissionRule.tool` 泛化为 `z.string()`，新增 `decision: allow|deny`（deny 优先于 allow）；`permission-rules.ts` 的 `keyOf()` 为 `shell.run`（命令前缀）/`fs.write`（文件路径）/`deploy.run`（配方 ID）三个工具提供 key 提取，CLI 审批菜单同步加了"拒绝并记住"选项。单测：`apps/sidecar/test/permission-rules.test.ts`、`apps/sidecar/test/auto-approve.test.ts`、`apps/cli/test/approval-payload.test.ts`。**仍遗留**：规则全局生效，无项目/会话级 scope；新增其他高风险工具要走这条路径需在 `keyOf()` 里补一行映射，不是自动生效。
- [x] 长会话压缩是否已有"失败熔断/分级回退"，而不是压缩失败就崩溃？——**2026-11-03 核实：措辞需澄清，行为本身没问题**。`conversation-context.ts` 的 `prepare()`(阈值触发)/`compact()`(强制) 失败时会 `catch` 并重新 `throw`（L458-466），原始消息（ConversationStore 落盘）和上一次有效摘要都不会被破坏——这是"数据不腐化"的熔断，但**不是**"失败后自动降级/跳过本轮继续执行"：异常会冒泡到 `chat.ts`/`task-executor.ts` 的外层统一 catch，导致该次聊天/任务整单失败。单测：`apps/sidecar/test/conversation-context.test.ts:320-344`。本文档第 15 行及第 2 节模式 #3 的"失败熔断"措辞指的是前者，不要理解成后者。
- [x] 子代理委派的工具集中是否意外包含了"派生子代理"的工具（递归爆炸风险）？——**2026-11-03 核实：不存在递归风险，结构性隔离**。`agents.delegate` 是 `orchestrator.ts:180-219` 在 `Orchestrator.run()` 内临时创建的本地工具对象，从未 `registry.register()` 注册进 `ToolRegistry`；子 Agent 工具集统一来自 `registry.select(def.tools)`（找不到未注册的工具），且该工具 schema 本身排除了委派给 orchestrator 自己（`orchestrator.ts:178,186`）。无论子 Agent 定义里的工具模式写多宽都不可能匹配到它。
- [x] 技能 `allowed-tools` 字段解析成功是否被误当成"工具权限已强制执行"？——**2026-11-03 核实后已修复**：原先确系"解析了但从未在任何工具调用入口被读取"，只是展示给模型/前端看。现已新增 `AgentTool.restrictsToolsTo`，`skills.load` 成功执行后据返回的 `allowedTools` 收紧本次运行的工具集（多技能取并集，空数组不收紧），`packages/agent-core/src/agent.ts` 的 `executeToolCall` 在调用前校验。**范围是最小实现**：只在模型显式调用 `skills.load` 之后、当次 Agent 运行内生效；靠关键词触发自动注入提示词的技能不会收紧（没有对应的工具调用事件可挂钩）；完整的 Pre/PostToolUse Hook 生命周期（模式 #5）仍未建设。单测：`packages/agent-core/test/agent.test.ts`、`packages/agent-core/test/skills.test.ts`。
- [x] 跨端（CLI/桌面）审批是否存在重复提交、或一端处理后另一端仍在等待本地输入的问题？——**2026-11-03 核实已解决**：`apps/sidecar/src/services/approvals.ts:84-97` 的 `resolve()` 对非 pending 状态直接幂等返回；CLI 端 `useApprovalWaiter.ts` 轮询检测远端决定并标记 `source: "remote"` 时跳过本地 POST；桌面端走 SSE + 15s 轮询兜底；快照恢复不重放旧事件，本地 `resolvedApprovals` Map 去重。集成测试：`apps/cli/test/interactive-task.test.ts:44-103,316-375`。小缺口：sidecar 层缺一个直接针对 `resolve()` 二次调用幂等性的单元测试（非功能性风险，锦上添花项）。

## 7. 这份文档怎么用

1. **动手重构/写新功能前**，先读本文档第 2、6 节确认适用的模式和 checklist；再读 `docs/claude-code-parity/` 对应文件确认当前差距是否仍然存在（代码可能已经先于文档演进）。
2. **本文档描述的是规则，不是任务清单**。具体要做哪个 backlog 项、做到什么程度，由每次对话/任务单独确认范围，不要把"规范允许"当成"现在就该做"的授权。
3. **规则更新**：如果某条规则被证明不适用或需要调整，直接编辑本文件并在 git 提交信息里说明原因，不要在别处另建一份互相矛盾的规范文档。
4. 本文档与 `docs/claude-code-parity/` 的分工：**这里是"为什么这样做、怎么做"的规则层**；那边是"现在做到哪一步了"的证据层。两者都过期时以重新核实代码为准，不要互相当作对方已经验证过的依据。
