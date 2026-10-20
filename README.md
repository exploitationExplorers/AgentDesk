# AgentDesk · 个人 Agent 工作台

一个运行在本机的 Agent Bot 桌面应用：统一管理 GitHub / Gitee / 公司 GitLab 项目，一键在 Cursor 或 Claude Code 打开，浏览器自动化完成宝塔面板部署，每天推送 GitHub 热榜与 AI 前沿速览，并提供类扣子的可视化工作流。

## 功能

| 模块   | 能力                                                                                                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Bot    | 多 Agent（总控 + 项目 / 部署 / 研究 / 编码），工具调用、危险操作审批、Skills 渐进加载，Grok 风格对话界面                            |
| 项目   | 扫描本地仓库，识别 GitHub / Gitee / GitLab，展示分支、未提交、未推送、PR/MR，一键 Cursor / Claude Code / 终端，Claude Code 会话列表 |
| 部署   | 宝塔服务器档案（密码加密），IM 等部署配方模板，Playwright 驱动系统 Edge 自动登录与执行，逐步日志截图、失败步骤重试、验证码人工接管  |
| 热榜   | GitHub Trending（多语言）、HuggingFace、Hacker News，LLM 中文摘要与领域分类，每日速览，定时抓取                                     |
| 工作流 | React Flow 画布，14 类节点（大模型、Agent、工具、条件、循环、审批、HTTP、Shell、Git、宝塔部署、通知…），定时触发，Bot 可调用        |
| 设置   | 从 CC Switch / `.env` 一键导入 Key（只显示脱敏值），中转站模型列表拉取，各 Agent 模型绑定与备用模型，Git Token，代理                |

## 架构

```
apps/
  desktop/        Tauri 2 + React 19 + Vite + Tailwind v4 + TanStack Router/Query + Zustand
    src-tauri/    Rust 外壳：系统钥匙串主密钥、拉起并守护 sidecar、托盘、通知、自动更新
  sidecar/        Node + Hono 本地服务（127.0.0.1 + 会话令牌），SQLite（better-sqlite3 + drizzle）
packages/
  agent-core/     基于 pi-ai 的 Agent 循环、Orchestrator、工具注册与审批、Skills、结构化输出
  workflow/       工作流 DSL（zod）、DAG 执行器、模板
  integrations/   Git 平台适配器、本地 Git、启动 Cursor/Claude、热榜抓取、宝塔浏览器自动化、Key 导入
  shared/         前后端共享的 zod 契约与错误码
  ui/             设计系统组件与主题
```

- UI 只通过 HTTP/SSE 与 sidecar 通信；sidecar 只监听回环地址，并校验 Tauri 每次启动生成的随机令牌。
- 密钥采用信封加密：主密钥保存在 Windows 凭据管理器，数据库中只有 AES-256-GCM 密文；接口永远不返回明文。
- 有副作用的工具按风险分级（safe / confirm / dangerous），非 safe 操作生成审批卡片，用户确认后才执行。
- 模型调用对中转站的瞬时错误（过载、限流、5xx）自动退避重试，再按绑定顺序切换备用模型。

## 开发

需要 Node 22+、pnpm 10、Rust（MSVC 工具链）、系统 Edge 或 Chrome。

```bash
pnpm install

# 方式一：完整桌面应用（Rust 会自动拉起 sidecar）
pnpm --filter @agentdesk/desktop app:dev

# 方式二：浏览器调试 UI（两个终端）
pnpm --filter @agentdesk/sidecar dev      # http://127.0.0.1:17890
pnpm --filter @agentdesk/desktop dev      # http://localhost:1420
```

国内网络下 sidecar 会依次使用：设置中的代理 → `HTTPS_PROXY` 环境变量 → Windows 系统代理。

### 常用脚本

```bash
pnpm typecheck   # 全量类型检查
pnpm lint        # ESLint
pnpm test        # 单元 / 集成测试（vitest）
pnpm --filter @agentdesk/desktop e2e     # Playwright E2E（真实 sidecar + UI，使用系统 Edge）
```

提交信息遵循 Conventional Commits（commitlint），提交前自动 lint-staged。

## 打包 Windows 安装包

```bash
# 1. 生成更新签名密钥（只需一次，私钥妥善保管，不要提交）
pnpm --filter @agentdesk/desktop tauri signer generate -w %USERPROFILE%\.tauri\agentdesk.key

# 2. 构建（sidecar 打包为 index.mjs + node.exe + 原生模块，随安装包分发）
set TAURI_SIGNING_PRIVATE_KEY=<私钥内容>
pnpm --filter @agentdesk/desktop app:bundle
```

产物在 `apps/desktop/src-tauri/target/release/bundle/nsis/`。自动更新地址在 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`，发布时把 `latest.json` 和安装包上传到对应位置即可。

## 首次使用

1. **设置 → 模型**：从 CC Switch 或 `.env`（如 `D:\AI agent\langsmith\.env`）导入，点“测试”确认可用；中转站可点“获取可用模型”选择分组支持的模型。
2. **设置 → 通用**：添加项目扫描目录（如 `D:\agent`），回到项目页点击“扫描项目”。
3. **设置 → Git 平台**：填 GitHub / Gitee / GitLab Token（GitLab 填公司域名），即可看到 PR/MR。
4. **部署**：添加宝塔服务器（面板地址包含安全入口），用 IM 模板生成配方，点“部署”。首次遇到验证码时会弹出浏览器窗口让你手动登录，之后复用登录态。
5. 在 Bot 里直接说“部署 IM 项目”“今天热榜有什么值得看的”“哪些项目还没提交”。

## 扩展 Skills

在 `%APPDATA%\AgentDesk\skills\<name>\SKILL.md` 放置技能文件（frontmatter 包含 `name`、`description`、`agents`、`triggers`），重启后 Agent 会按需加载。内置示例见 `apps/sidecar/skills/`。
