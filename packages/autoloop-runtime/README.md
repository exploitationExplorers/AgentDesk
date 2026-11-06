# Autoloop runtime for AgentDesk

本包将固定版本的 Autoloop Hub 作为独立本机进程运行，供 AgentDesk sidecar 使用。默认绑定 `127.0.0.1` 的随机端口，Hub 数据库与 AgentDesk 数据库分离。Windows 适配由 AgentDesk 维护，不代表上游已经发布 Windows 支持。

## 固定版本与构建

- 上游：`KKKKhazix/agent-autoloop`，提交 `22312e16419fc9f542a58044cfbb76f4aec80623`，版本 `1.1.1`，MIT 许可证。
- Hub：Node `24.11.1`，使用该版本内置的 `node:sqlite`。
- 当前锁定的发行目标：`win32-x64`。其他目标需要单独登记官方运行时哈希、构建和验证。
- sidecar 的 Node 和 `better-sqlite3` 单独打包、单独记录 ABI，不能加载 Hub 的原生模块来替代它。

构建机需要 Node、pnpm 和 Rust 工具链。首次准备时，将官方运行时放到本包的 `.runtime/node.exe`，并将同版本官方 `LICENSE` 放到 `.runtime/LICENSE`。也可通过 `AGENTDESK_AUTOLOOP_NODE` 指向已准备的运行时；许可证必须在其同目录。下载地址及官方 SHA256 记录在 [runtime-lock.json](runtime-lock.json)，校验来源为 Node 官方 `SHASUMS256.txt`。

构建脚本不会自动下载或接受构建机的任意 Node。它在执行候选二进制之前比对锁定的 SHA256，然后核对版本、平台和架构：

```powershell
corepack pnpm --filter @agentdesk/autoloop-runtime build
corepack pnpm --filter @agentdesk/autoloop-runtime test
```

`apps/sidecar/scripts/build.ts` 和 `apps/cli/scripts/build.ts` 共用 `copyAutoloopRuntime()`。此函数验证上游文件哈希，编译生产模块，使用 `cargo build --release --locked` 构建 Supervisor，并复制运行时和许可证。构建失败时不应继续发布其输出目录。

## 源码与发行资源

`vendor/` 保留固定提交的必要上游源码和资源；`upstream-manifest.json` 对每个文件同时记录上游哈希与应用补丁后的哈希。补丁放在 `patches/`，上游许可证保存在 `LICENSE.upstream`。升级上游时应重新审查补丁并运行官方协议一致性测试。

源码启动时优先使用 `.runtime/node.exe`；发布启动必须使用安装包内置运行时。生产资源保留上游目录结构，将 TypeScript 编译为 `.mjs`，避免 Node 在 npm `node_modules` 目录中拒绝剥除 TypeScript，同时保持 SQL/JSON 资源相对路径有效。原始源码随包保留，便于审计。

生成的 `runtime-manifest.json` 记录 Node、SQLite、ABI、平台和架构，并包含发行目录内每个文件的 SHA256，包括 `node.exe`、Supervisor、编译模块、补丁文件和原始 vendor 文件。清单自身不参与递归哈希。Hub 启动时验证 Node 版本、架构、平台和可执行文件哈希。此清单不是代码签名，也不是对全部文件的启动时签名验证。

## 进程与私有数据

`src/index.ts` 提供 `startAutoloopRuntime()`、规则更新、会话取消和停止能力。启动凭据经过私有临时文件传入，文件在启动后删除；不通过前端或命令行参数传递令牌。Hub 的子进程环境使用白名单。

Windows 写密钥前设置仅当前用户与 SYSTEM 可访问的 DACL，拒绝盘符相对路径、UNC 和重解析跳转。Hub 使用本机独占锁防止同一数据目录重复启动。网页 Origin 请求及上游 webhook/card 页面入口不开放。

`crates/agentdesk-supervisor` 使用 Windows Job Objects 管理本应用创建的进程树。子进程以暂停状态创建，加入 Job 后恢复；Job 句柄不继承，Supervisor 被强制结束时清理其子孙进程。Tauri 与 CLI 共用该实现；CLI 后台服务使用常驻模式，前台服务可协作退出。同一数据目录的宿主实例通过共享 Rust 实例锁排他运行。Job Objects 负责生命周期，不是文件或网络权限沙箱。

当前是宿主级进程树管理，未提供每个业务任务独立的 Job Object。任务取消仍须由执行器传播取消并核验副作用。

## 本地补丁

`windows-host.patch` 修复 Windows 绝对目录校验、规则文件 watcher 的 basename 判断，并允许显式强制重新加载规则。规则更新先验证、再原子替换，收到 Hub 应用确认后才算成功。

`session-cancellation.patch` 增加 `cancelSession` 核心命令，仅由受控宿主 IPC 调用，不新增公开 HTTP 路由。命令沿用上游 `decide → facts → commitLatest` 事务路径，在一个事实中：

- 关闭指定 session 的 `open` 和 `decided` 卡片。
- 删除尚未触发的定时器。
- 取消 `session` 或 `resume` 匹配的排队轮次。
- 标记已领取或结果未知的轮次，向 Worker 发出停止信号。

取消标记会阻止迟到回执创建新卡片、定时器或后续事件；回执仍保留用量和重发去重信息。重复取消幂等，其他 session 不受影响。此扩展不撤销已经发生的外部副作用，也不删除历史记录。

## 升级与验证边界

数据目录记录 `data-version.json`。在打开上游数据库前，宿主校验数据 schema 与上游提交；既有数据库没有版本记录、版本不兼容或主密钥缺失时拒绝启动。不会自动重新生成缺失主密钥，也不会对未知版本直接重放迁移。失败不会改写已有数据库。

本包尚未提供完整的数据备份、跨版本迁移和自动回退。有效恢复需要同时考虑 Hub 数据库及 WAL、Hub master key、AgentDesk 数据库中的映射/队列/checkpoint、连接凭据和产物引用。运行时不能只复制 `hub.db`。发布升级前，应先实现并验证停止所有写入后的完整备份或相应数据库备份协议。

已在当前 Windows x64 开发环境验证真实 TCP 协议、上游 conformance、中文和空格路径、DACL 配置、规则热更新、重启续答、取消事务、迟到回执拒绝，以及 Supervisor 子孙进程清理。发行资源在 `node_modules` 安装路径下也经过测试。

尚未完成干净 Windows 10/11 安装矩阵、另一个普通账号访问验证、ARM64 发行、签名、安装升级/卸载与完整回退验收。构建及开发环境测试通过不等同于这些发行验收已经完成。
