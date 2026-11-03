# UI / 交互参考对照：AgentDesk vs. magpie vs. pi

> 调研日期：2026-11-03。对应 `docs/engineering-standards.md` 的姊妹文档，但这里关注"界面长什么样、怎么动"，不重复那边"Agent Loop/权限/压缩"这些后端设计模式。

## 0. 文档定位与证据边界（请先读）

本文档的素材来自对两个第三方开源项目的**只读结构调查**：在独立的临时目录（`/tmp/ui-research/`，不在本仓库内）浅克隆了

- [`yetone/magpie`](https://github.com/yetone/magpie)（MIT License，commit 为调研当日 main 分支最新）
- [`earendil-works/pi`](https://github.com/earendil-works/pi)（MIT License，commit 为调研当日 main 分支最新）

调研方式是读取两者的目录结构、`package.json`、文件命名、CSS `@keyframes` 名称列表，**没有逐行阅读或复制它们的源码正文**，也没有构建或运行这两个项目。本文档里出现的"组件清单""动效词汇表"是对上述结构信息的归纳整理，不是源码引用；本文档不包含、也不建议直接拷贝这两个仓库的任何源文件到 AgentDesk ——下面第 5 节会说明原因。

两个项目都是 MIT 协议，参考其架构思路、视觉语言、交互模式本身没有法律障碍，但"移植"在本文档里统一理解为**用 AgentDesk 自己的技术栈重新实现同等的视觉/交互效果**，而不是逐文件搬运。

## 1. 三个项目速览

|                | AgentDesk（本仓库现状）                                                                                             | magpie                                                                                                            | pi                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 定位           | 多端 Agent 编码工具：常驻 sidecar + 桌面"编码现场" + CLI                                                            | 本地模型网关 + 菜单栏桌面应用，把 Claude Code/Codex/Gemini CLI 等客户端的模型来源统一管理                         | 极简、可扩展的 Agent Harness（CLI + TS SDK），刻意不内置子代理/Plan Mode，靠扩展/技能/主题包定制                                  |
| 后端语言       | TypeScript（Node/Hono）                                                                                             | Go                                                                                                                | TypeScript（Node/Bun）                                                                                                            |
| 桌面端技术栈   | Tauri 2 + React 19 + Tailwind CSS v4                                                                                | Go 原生应用外壳 + 内嵌 HTTP 服务渲染**无框架 vanilla JS/CSS** 前端（无 React/Vue/Svelte，无构建产物里的虚拟 DOM） | 无独立桌面端；通过 CLI + 可选 Web/RPC 模式对外                                                                                    |
| 终端 UI 技术栈 | Ink 8（React 渲染到终端的虚拟 DOM 方案）                                                                            | 不适用                                                                                                            | 自研 `@earendil-works/pi-tui`：**差分渲染**（differential rendering）终端框架，不依赖 React                                       |
| 动画/动效方案  | **无专门动画库**（CLI 和桌面端都只有零散的 CSS transition / Ink 重渲染，没有统一的动效系统）                        | 纯 CSS `@keyframes` + vanilla JS 状态机驱动，自成一套命名规范的动效词汇表（见第 2 节）                            | 终端内动效由 `pi-tui` 的差分渲染 + OKLab 色彩空间插值实现（终端没有 CSS，动效是"每帧重算需要变化的字符/颜色" 而不是"关键帧过渡"） |
| 主题系统       | CLI 有 `apps/cli/src/interactive/theme.ts` 做无障碍主题；桌面端 Tailwind 的 light/dark media query，无统一 token 层 | 原生 CSS 变量 + `prefers-color-scheme`，无独立"主题包"概念                                                        | **一等公民**：`dark.json`/`light.json` 主题 token 文件 + `theme-controller`（可跟随系统）+ 可安装的第三方主题包                   |
| License        | 私有                                                                                                                | MIT                                                                                                               | MIT                                                                                                                               |

## 2. magpie：vanilla JS 桌面应用的动效词汇表

magpie 的前端（`internal/gui/assets/`）完全不依赖前端框架：`app.js`（约 2.4 万行）+ `app.css`（约 4850 行）+ 若干按功能拆分的 `plugins/<name>/` 子目录（每个功能面板一个 JS + CSS 对），由 Go 内嵌的 HTTP 服务直接把这些静态资源和一个 `index.html` 发给 WebView 外壳渲染。这是一种"重前端、零框架"的架构：组件化靠手写的 DOM 操作函数（`kernel.js`/`layout.js`/`navlamp.js` 等文件名可以看出按"内核/布局/导航高亮"这样的职责切分），不是组件树 diff。

通过统计 `app.css` 和 `plugins/routing/routing.css` 里的 `@keyframes` 声明，可以归纳出一套按"语义角色"命名、而不是按"视觉效果"命名的动效词汇表（例如不叫 `fade`，而叫 `view-in`，表达"这是一次视图切换"）：

| 语义角色        | 对应 keyframes（举例）                                                             | 用途推测                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 品牌/吉祥物动效 | `bird-bob` `wing-flap` `tail-flick`                                                | 菜单栏图标里的鸟形吉祥物待机动画                                                                                 |
| 面板/视图转场   | `pop-in` `pop-out` `pop-fade` `side-in` `side-out` `view-in` `sub-in` `content-in` | 弹出面板出现/消失、侧边栏滑入滑出、子视图切换                                                                    |
| 加载态          | `skeleton-shift` `spin` `ps-wait`                                                  | 骨架屏微光扫过、转圈 loading、"处理中"等待态                                                                     |
| 实时/在线态     | `new-dot-in` `new-dot-ring` `rtlive` `rppulse` `rttick`                            | 新消息小红点出现+扩散光圈、"实时"状态的脉冲心跳                                                                  |
| 操作反馈        | `copy-pop` `flash` `pq-mode-flash`                                                 | 点击复制按钮的小弹跳反馈、状态切换时的高亮闪烁                                                                   |
| 路由可视化专属  | `rtcome` `rtflow` `rtfound` `rthit` `rtin` `rtheld` `rtpii`                        | 对应截图里那张"请求如何路由到哪个模型"的节点图：数据点沿虚线连接线流动、命中某条规则时节点高亮、PII 脱敏标记闪现 |

截图中的路由图谱（卡片 + 虚线连接线 + 空心/实心 radio 指示 + 底部统计条）是上述 `rt*` 系列动效的落地场景：左侧"来源"卡片、中间"网关"卡片、右侧规则列表卡片之间用虚线连接，命中的规则会有一个实心圆点和加粗边框，推测是靠 JS 给对应 DOM 节点切换 class 触发 `rtfound`/`rthit` 这类 keyframes，而不是用 Canvas/SVG 做整体重绘。这种"少量 DOM 节点 + CSS 动画 + JS 只管加减 class"的做法，天然比"每帧用 Canvas 重绘整张图"更省资源，也更容易用 React 的方式复刻（state 决定 class，CSS 管动画）。

## 3. pi：差分渲染终端 UI + 主题/组件体系

`earendil-works/pi` 是一个 TypeScript monorepo（`packages/*`），和 AgentDesk 有直接血缘关系——AgentDesk 当前依赖的 `@mariozechner/pi-ai` 正是同一作者（Mario Zechner）早期发布的同一套库，现在整体搬到了 `@earendil-works` 这个组织下、拆分成 `pi-ai`/`pi-agent-core`/`pi-tui`/`pi-coding-agent` 等独立包并持续演进。这意味着参考 pi 的设计不是"引入一个陌生项目的理念"，而是"看清楚我们已经在用的底层库，后来者长成了什么样"。

### 3.1 `@earendil-works/pi-tui`：不是 Ink 的另一条路

package 描述自称"Terminal User Interface library with differential rendering for efficient text-based applications"。和 AgentDesk CLI 现在用的 Ink（React 渲染到终端，本质是"每次状态变化整体重算虚拟 DOM 再 diff 出最小终端写入"）不同，`pi-tui` 是一套**不依赖 React** 的独立终端渲染层，源码目录透露出的技术特征：

- `oklab.ts` / `terminal-colors.ts`：用 OKLab 感知均匀色彩空间做颜色插值——这是让终端里的渐变色、高亮色过渡看起来"顺眼"而不是"一步到位生硬跳变"的关键技术，比直接在 RGB 空间插值的渐变观感更自然。
- `native-module-path.ts` / `native-platform.ts` + 按平台分的 native 构建脚本：剪贴板等需要原生系统调用的能力不绕路通过终端转义序列模拟，而是编译原生模块。
- `mouse-region.ts` / `wheel-scroll.ts`：终端鼠标区域事件和滚轮支持，Ink 默认不提供。
- `scroll-view.ts` / `select-list.ts` / `editor.ts` / `markdown.ts` / `image.ts`：和 AgentDesk CLI 里 `ScrollViewport`/`Select`/`ApprovalCard` 这些组件是同一层级的概念，只是实现方式不同（差分渲染 vs React 组件树）。

**这对 AgentDesk 的含义**：Ink 已经能满足当前功能，但如果未来要做"大量实时刷新又要保持低延迟"的场景（比如同时流式展示多个并行子代理的输出），差分渲染架构理论上比"整树 reconcile"更省 CPU。这是一个**架构级决策**，不是换个依赖包就能做到的小改动，建议单独评估，不在本轮顺手做。

### 3.2 `pi-coding-agent` 交互模式的组件/主题体系

`packages/coding-agent/src/modes/interactive/` 下的组件命名呈现出几条值得借鉴的约定：

1. **统一的 Selector 家族**：`model-selector` `theme-selector` `session-selector` `config-selector` `trust-selector` `thinking-selector` `oauth-selector` `tree-selector` ……所有"从列表里选一项"的交互都遵循同一套命名和（推测）同一套底层组件，而不是每个选择场景各写一套。AgentDesk CLI 目前有 `Select` 组件但审批菜单（`approvalOptionsFor`）、会话选择器等各自手写交互逻辑，没有统一到一个"Selector 家族"概念下。
2. **主题是数据，不是代码**：`theme/dark.json` `theme/light.json` + `theme-schema.ts`（校验 schema）+ `theme-controller.ts`（运行时切换/持久化）+ `system-theme.ts`（跟随系统）。主题变成可以被第三方包替换的 JSON 数据，而不是写死在组件样式里的颜色值。AgentDesk CLI 的 `theme.ts` 现在是 TS 常量，桌面端是 Tailwind class，两边没有共享的 token 层。
3. **消息渲染按"消息类型"拆组件**：`assistant-message.ts` `user-message.ts` `tool-execution.ts` `bash-execution.ts` `compaction-summary-message.ts` `skill-invocation-message.ts` `branch-summary-message.ts`——每种语义消息一个组件文件，而不是一个大组件里 switch-case。这一点 AgentDesk 的 `StepRow`/`ApprovalCard` 已经部分做到，但压缩摘要、技能调用这些语义目前混在通用的工具调用展示里，没有专门的视觉表达。
4. **即时反馈的小组件很多**：`countdown-timer` `bordered-loader` `status-indicator` `keybinding-hints`（底部常驻快捷键提示）`dynamic-border`（边框随状态变色/呼吸）。这些都是"状态 → 一小块可复用 UI"的最小粒度组件，AgentDesk CLI 目前这类反馈大多内联写在 `TaskView`/`App.tsx` 里，没有拆成独立可复用组件。
5. **富内容内联渲染**：`diff.ts`（差异高亮）、`mermaid.ts`（在终端里渲染 Mermaid 图！）、`markdown-transform.ts`。AgentDesk CLI 已经有自己的 diff 展示（审批卡片里的文件差异），但没有 Mermaid 这类图表的终端渲染能力。

## 4. AgentDesk 当前状态核查（本轮已验证）

直接读取仓库依赖清单确认：

- `apps/cli/package.json`：`ink@^8.0.0` `ink-text-input@^6.0.0` `react@19.3.1`，**没有任何动画库**（无 `framer-motion`/`motion`/`react-spring` 等）。
- `apps/desktop/package.json`：`react@^19.2.0` `react-dom@^19.2.0` `react-markdown@^10.1.0` `tailwindcss@^4.1.14`，**同样没有动画库**；样式集中在 `apps/desktop/src/styles.css` 一个文件。
- CLI 已有的主题相关文件：`apps/cli/src/interactive/theme.ts`（无障碍主题判定）、`apps/cli/src/interactive/colors.ts`（刚在本轮改成字面量联合类型的 `ColorToken`，见 `docs/engineering-standards.md` 的提交记录）——有主题"概念"，但没有 pi 那种"外部 JSON token + 可替换主题包"的结构。

结论：AgentDesk 两端目前都是"功能完整、但视觉/动效系统是朴素默认值"的状态，这正是用户反馈"样式和动画不满意"的技术根因——不是哪里做错了，而是这部分从来没有被当作一个独立的设计系统来建设。

## 5. 为什么不能"直接移植"，以及真正能搬过来的是什么

逐文件照搬不可行，原因是纯技术性的，不是版权问题（两者都是 MIT）：

- magpie 的前端是 **Go 服务 + 无构建步骤的 vanilla JS**，AgentDesk 桌面端是 **Tauri + Vite + React**。两者的组件化方式（手写 DOM 操作 vs React 组件树）、状态管理方式、构建产物形态完全不同，magpie 的 `.js`/`.css` 文件拿过来无法直接在 React 里运行，语义上也要重新表达成组件而不是全局函数。
- pi-tui 是**不依赖 React 的差分渲染引擎**，AgentDesk CLI 是 **Ink（基于 React）**。两者的渲染模型不兼容，pi-tui 的组件代码无法作为 Ink 组件直接复用。

**真正可以、也应该搬过来的是三样东西**，而且都不需要逐文件拷贝代码：

1. **动效/视觉词汇表的组织方式**（来自 magpie）：按"语义角色"而不是"效果名字"命名动效，建立一份 AgentDesk 自己的 `motion-tokens`（转场/加载态/实时态/反馈态四大类），用 AgentDesk 自己的动画库实现。
2. **主题即数据、Selector 即家族、消息按类型拆组件**的组织方式（来自 pi-coding-agent）：这是信息架构层面的约定，和具体用什么渲染引擎无关，CLI（Ink）和桌面端（React）都可以照着这个思路重新组织现有组件，不需要换底层技术栈。
3. **差分渲染的技术方向**（来自 pi-tui）：作为中长期、需要单独立项评估的选项记录下来，不在本轮直接动手。

## 6. 差距表与落地建议（分阶段，不是一次性重写）

| 阶段                    | 范围             | 现状差距                                  | 建议                                                                                                                                                                                                                           |
| ----------------------- | ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1                       | 桌面端动画基建   | 零动画库，面板出现/消失、列表增删都是硬切 | 引入 `motion`（Framer Motion 的轻量继任者，React 生态里目前最成熟的声明式动画库，Bundle 体积和 API 都优于老版 `framer-motion`）；先覆盖 `ArtifactWorkspace`/`SessionPanel`/`ConversationList` 这几个本周期新增的面板组件做转场 |
| 2                       | 桌面端动效词汇表 | 没有统一命名规范                          | 参照第 2 节四分类（转场/加载态/实时态/反馈态），在 `packages/ui` 下建立共享的 `motion` 预设（`variants.ts`），新组件统一引用，不再各写各的 CSS transition                                                                      |
| 3                       | CLI 主题结构     | `theme.ts`/`colors.ts` 是写死的 TS 常量   | 拆成 token 数据（保持 TS 类型安全，不必照搬 JSON）+ 一个 `ThemeController`，为未来"用户自定义终端配色"留口子；不强求引入外部可安装主题包                                                                                       |
| 4                       | CLI 组件信息架构 | 审批/会话选择/技能等交互各写各的          | 梳理出 AgentDesk 自己的 Selector 家族（已有 `Select` 组件打底，统一接入点即可），压缩摘要等语义消息拆出独立展示组件                                                                                                            |
| 5（中长期，需单独立项） | CLI 渲染架构     | Ink 是否够用取决于未来的并行流式规模      | 不在本轮动手；记录为"如果未来出现 Ink 的性能/能力瓶颈，差分渲染是经过验证的替代方向"                                                                                                                                           |
| 6（中长期，视需求）     | 状态可视化图谱   | 无此类组件                                | 如果未来 AgentDesk 需要类似"任务路由/依赖关系图"的可视化，复用阶段 2 建立的动效词汇表实现，不是现在就要做                                                                                                                      |

阶段 1–4 是本文档认为当前就可以排期的"结构对齐 + 质量提升"；阶段 5–6 刻意标注为"需要单独讨论"，避免把"参考里有这个能力"直接当成"现在就要做"的授权——这和 `engineering-standards.md` 第 7 节的原则一致。

## 7. 本文档怎么用

和 `docs/claude-code-parity/` 一样，这里是"现状 vs 参考"的证据层，不是任务清单；具体做到阶段几、先做哪个组件，由每次对话单独确认范围。配套的可视化版本见 `docs/ui-reference-parity/dashboard.html`。
