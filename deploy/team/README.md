# AgentDesk 团队站

独立的项目群聊与任务协调服务。团队网页和记录部署在服务器，模型、Git 工作目录、检查及开发进程运行在各成员电脑上；不需要把模型 API Key 交给团队服务。

## 服务部署

需要 Node.js 22.12+、Git、pnpm 10.33.3，以及 HTTPS 反代。SQLite 原生模块须在目标系统构建，不要把 Windows 的 node_modules 复制到 Linux。

```sh
pnpm install --frozen-lockfile
pnpm --filter @agentdesk/desktop build:team
pnpm --filter @agentdesk/sidecar build:team
```

产物 `apps/sidecar/dist-team/` 包含服务、web 和运行依赖。在目标服务器放到 `/opt/agentdesk-team/`，建立专用低权限用户和数据目录。复制 [team.env.example](team.env.example)，设置真实的 `TEAM_PUBLIC_ORIGIN`、管理密钥文件、数据路径和静态网页路径。

管理密钥在服务器本地用随机生成器产生，保存到 `TEAM_ADMIN_KEY_FILE` 指向的文件；父目录权限 700，文件 600，仅服务用户与管理员可读。此密钥用于创建项目，不是模型 API Key，普通成员不需要。不要提交到仓库。

按 [systemd 示例](agentdesk-team.service) 设置实际路径并启动；也可在正确设置这些环境变量后运行 `node /opt/agentdesk-team/team.mjs`。服务固定绑定 `127.0.0.1`，默认端口 17895。宝塔或 Nginx 参考 [反代配置](nginx.conf.example)，只代理团队服务，不公开整个个人 Sidecar。团队接口前缀为 `/team-api/v1`，健康检查 `/health`。

线上需配置 HTTPS 续期，以及 SQLite 在线备份、密钥／配置备份和恢复验证。备份含项目记录和会话凭证摘要，应加密存储并另存异地。本仓库的配置示例不自动安装证书或备份任务。

## 发布轻量连接端

在源码根目录构建：

```sh
pnpm --filter chuxin-agentdesk build:team-client
```

构建日志会输出包目录。进入该目录执行 `npm pack --ignore-scripts`，将生成的 tgz 和 SHA256 校验信息发布到自己的 HTTPS 下载地址。该包没有执行模型的云端能力，只复用本机团队客户端；默认不会发布到 npm。

成员使用部署者提供的实际 URL 安装：

```sh
npm install -g https://team.example.com/downloads/你的团队连接端.tgz
agentdesk-team --help
```

也可使用包含此功能的完整源码构建 CLI，将下列 `agentdesk-team` 替换为 `agentdesk team`。旧版 npm 完整包可能尚不包含团队命令。

## 建群、配对、领取

1. 负责人在 `https://team.example.com/#/team` 创建项目，输入目标、不含凭据的 HTTPS 仓库地址、完整 40 位起始提交 SHA，以及服务管理密钥。
2. 每位朋友使用不同的单次邀请链接。链接有效期 24 小时，成功加入即失效；旧链接报错时由负责人生成新的链接。已加入者继续使用自己的浏览器项目会话。
3. 各成员在自己的网页点击「连接我的 Agent」，获取 10 分钟有效的单次配对码，在自己的交互终端运行：

```sh
agentdesk-team pair --server https://team.example.com
agentdesk-team read
agentdesk-team say "建议先对齐接口契约，再拆分任务"
```

4. 本机安装并配置可用的 Codex CLI、Claude Code 或自定义 Agent。克隆同一仓库并取得读写授权；原始仓库应保持干净。参考 [runner.example.json](runner.example.json) 创建本机检查配置，把示例检查换成实际项目命令。

```json
{
  "executor": "codex",
  "args": [],
  "checks": [{ "name": "项目测试", "command": "node", "args": ["--test", "test/im.test.mjs"] }]
}
```

示例测试路径不是通用测试命令，必须替换。Claude Code 使用 `executor: "claude"`；自定义工具用 `custom` 并配置本机 `command` 和 `args`，任务提示作为最后一个参数传入。命令不经过 shell，Windows `.cmd/.bat` 不能直接作为检查 executable，可用 Node executable 加工具的 JS 入口。

```sh
agentdesk-team work --repo /path/to/project --runner-config /path/to/runner.json
```

5. 负责人在网页分配任务，执行成员在自己的任务卡片点击「领取任务」。保持 `work` 运行后自动接单，终端显示范围并等待本人输入 `yes`；网页操作不会替代本机权限确认。Windows PowerShell 可使用 `agentdesk-team.cmd`。
6. 开发发生在独立 worktree 和分支。完成提交、保持任务工作区干净并通过本机检查后，由成员确认推送、填写公开摘要。负责人复核代码和结果后验收。最后新建集成回归任务，选择已验收功能作为依赖，连接端合并其固定提交并执行回归，不自动合 main 或部署。

每个 `--data-dir` 保存一组当前项目连接；同时连接多个项目时，为各自的 pair/read/say/work 使用不同目录。

## 网页操作与状态

| 当前状态         | 执行成员本人                   | 负责人                             |
| ---------------- | ------------------------------ | ---------------------------------- |
| 待领取           | 领取任务，查看本机启动说明     | 查看；也可取消                     |
| 已领取、等待本机 | 撤回领取，启动本机执行器       | 查看；也可取消                     |
| 执行中           | 停止执行，查看进度             | 停止执行或取消                     |
| 已阻塞           | 确认旧进程停止后「重试并领取」 | 填写意见后明确重试或取消           |
| 待验收           | 查看交付与检查结果             | 填写意见后验收通过、退回修改或取消 |

负责人也可以领取分给自己的任务。普通成员不能操作他人的任务或验收交付。网页显示「已配对」只表示存在 Agent 绑定；`work` 最近有轮询／心跳才显示执行器在线。领取后依赖任务未验收、终端未运行或未确认时不会开始开发。

执行心跳每 10 秒，租约 45 秒；网页停止会使租约失效，执行器在下次心跳停止进程。关闭终端、断线或撤权会中止执行；过期任务显示阻塞，不自动重放。重试前核查本机旧进程已退出；重试使用新分支和 worktree，已有文件保留。

## 查看执行过程

使用轻量连接端 `0.1.2-preview.20261118` 或包含同等代码的完整 CLI，在任务卡片展开「执行过程」。阶段记录由本机上报，网页每 2 秒刷新，保留最近 240 条。光线只响应新增记录；刷新历史不重放，可暂停，也遵循系统减少动态效果设置。

需要让队友看到详细过程时，在自己的 runner 配置添加 `"shareExecution": true` 后重新启动 `work`。默认 `false` 只共享阶段，开启后会共享当前任务 worktree 对应的 Codex／Claude 可见回复和工具记录，以及检查和自定义执行器输出。隐藏推理和用户原文不投影到共享记录；会话日志格式不兼容时显示提示，完整过程仍在本机终端。

领取网页任务不等于模型已经启动。成员电脑必须运行 `work`，并在终端确认任务和工具审批；旧连接端需要升级。服务端和本机都做常见凭据格式过滤，过滤不保证覆盖所有业务秘密，开启详细共享前应确认输出范围。

## 数据与使用边界

- 普通聊天、引用和 @ 不会自动唤醒模型。外部 Agent 用 read/say 参与讨论，用明确分派的任务开发。
- 客户端不上传模型配置或认证文件。阶段、群消息、摘要、检查结果、Git 交付，以及显式开启后的详细执行记录是共享内容，勿写入密钥。测试结果由连接端上报，建议结合代码评审与 CI 验收。
- Git worktree 是代码目录隔离，不是操作系统沙箱；秘密扫描只是补充检查，不能保证识别所有格式，保留各 Agent 的工具审批。
- 当前为单进程 SQLite：每项目 30 位有效成员、200 项任务，普通聊天累计 2000 条，无归档或历史分页。浏览器会话和 Agent 凭据 30 天有效；尚无邮箱账号恢复，保留负责人浏览器数据，Agent 过期重新配对。
