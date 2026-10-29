<p align="center">
  <img src="apps/desktop/public/agentdesk.svg" alt="AgentDesk" width="80" height="80" />
</p>

<h1 align="center">AgentDesk</h1>

<p align="center">本地优先的个人 Agent 工作台。管理项目、改代码、跑任务，数据和密钥留在本机。</p>

桌面应用与 CLI 共用同一套引擎。模型、Git 平台和服务器由使用者自行配置。当前桌面安装包面向 Windows，CLI 通过源码构建使用，尚未公开发布。

## 界面

|                编码现场                |               Bot                |
| :------------------------------------: | :------------------------------: |
| ![编码现场](docs/screenshots/code.png) | ![Bot](docs/screenshots/bot.png) |

|                  项目                  |                热榜                |                  工作流                  |                 部署                 |
| :------------------------------------: | :--------------------------------: | :--------------------------------------: | :----------------------------------: |
| ![项目](docs/screenshots/projects.png) | ![热榜](docs/screenshots/feed.png) | ![工作流](docs/screenshots/workflow.png) | ![部署](docs/screenshots/deploy.png) |

## 能力

- **编码任务**：创建任务并查看时间线、文件差异和命令输出；审批、停止、续跑和验收都在同一处完成。关闭页面不会取消任务。
- **项目**：扫描本地仓库，查看分支、提交和 PR/MR，从 GitHub / Gitee 导入，并用 AI 生成提交说明。
- **Bot**：总控把工作分给项目、部署、研究和编码 Agent，工具调用需要确认。
- **浏览器与部署**：查看浏览器实况并接管登录；按配方在宝塔上部署，失败步骤可重试。
- **热榜与工作流**：汇总 GitHub、Hugging Face 和 Hacker News；用画布把模型、工具和审批串成可重复流程。
- **技能与记忆**：用 `SKILL.md` 扩展能力；记住稳定偏好，并在后续对话中召回。

命令细节见 [CLI 说明](apps/cli/README.md)。

## 快速开始

需要 Node.js 22+、pnpm 10 和 Git。完整桌面应用另需 Rust 与 Windows MSVC 工具链。

```powershell
pnpm install
Copy-Item .env.example .env

# 桌面应用
pnpm --filter @agentdesk/desktop app:dev

# 或只在浏览器里调试界面
pnpm dev:sidecar   # http://127.0.0.1:17890
pnpm dev:web       # http://localhost:1420
```

```powershell
pnpm build:cli
pnpm cli
pnpm cli run "梳理还没提交的项目"
```

首次打开后，在设置里添加模型、Git 平台 Token 和项目扫描目录。CLI 与桌面使用不同的数据目录和端口，需要分别初始化模型。

## 配置

复制 [`.env.example`](.env.example) 为 `.env`。API Key 和平台 Token 在应用设置中填写，不要放进 `VITE_*`。

| 变量                              | 作用                                |
| --------------------------------- | ----------------------------------- |
| `AGENTDESK_DATA_DIR`              | 数据库、任务、技能和浏览器登录态    |
| `AGENTDESK_SKILLS_DIR`            | 源码运行时的内置技能目录            |
| `AGENTDESK_PORT`                  | sidecar 端口，桌面模式由外壳注入    |
| `AGENTDESK_TOKEN`                 | 本地 API 令牌，桌面模式每次启动生成 |
| `AGENTDESK_ALLOWED_ORIGINS`       | 额外允许的界面来源，逗号分隔        |
| `AGENTDESK_WECHAT_REPORT_ENABLED` | 私有微信日报，默认关闭              |

优先级：系统环境变量 → 数据目录 `.env` → `apps/sidecar/.env` → 仓库根目录 `.env`。

Windows 默认数据目录是 `%APPDATA%\AgentDesk\`。桌面模式用系统钥匙串保护主密钥，凭据以 AES-256-GCM 存在本地数据库。CLI 使用自己的数据目录 `~/.agentdesk`，端口 `17891`。

自定义技能放在数据目录的 `skills/<name>/SKILL.md`。

## 开发

```text
apps/desktop     Tauri 2 + React 19
apps/sidecar     Node + Hono + SQLite
apps/cli         本地 CLI
packages/        Agent 循环、工作流、集成与共享契约
```

界面通过 HTTP/SSE 连接只监听 `127.0.0.1` 的 sidecar。需要确认的工具会生成审批。

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @agentdesk/desktop e2e
pnpm build
```

提交说明使用 Conventional Commits。提交前会检查私有文件和常见格式的密钥。

```powershell
pnpm --filter @agentdesk/desktop tauri signer generate -w C:\private\agentdesk.key
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw 'C:\private\agentdesk.key'
pnpm --filter @agentdesk/desktop app:bundle
```

安装包在 `apps/desktop/src-tauri/target/release/bundle/nsis/`。发布前把 [`tauri.conf.json`](apps/desktop/src-tauri/tauri.conf.json) 里的更新公钥和地址换成自己的。

密钥、数据库、浏览器登录态和私有技能不要提交。公开仓库前运行 `pnpm security:check --history`。
