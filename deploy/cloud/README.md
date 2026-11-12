# Linux / 宝塔部署包

先在本地构建和验证镜像，再部署到独立目录。首次上线仍需真实域名、SMTP 与 Git／模型配置。本目录不会自动访问服务器。

当前生产 Gateway 和 Runner 要求 PostgreSQL，缺少数据库配置会拒绝启动。下文原初始化工具只生成基础目录与配置，必须完成“PostgreSQL 生产部署”后再启动新版本。旧 SQLite 演练、备份和恢复流程不等于 PostgreSQL 生产验收。

## 构建

在仓库根目录构建 Linux amd64 镜像，使用同一不可变版本标签：

```sh
docker build --platform linux/amd64 -f deploy/cloud/Dockerfile --target gateway -t agentdesk-gateway:2026-11-09 .
docker build --platform linux/amd64 -f deploy/cloud/Dockerfile --target runner -t agentdesk-runner:2026-11-09 .
docker save agentdesk-gateway:2026-11-09 agentdesk-runner:2026-11-09 -o agentdesk-2026-11-09.tar
sha256sum agentdesk-2026-11-09.tar > agentdesk-2026-11-09.tar.sha256
```

生产 cloud 镜像显式关闭 Autoloop，使用固定 Node 22、同平台编译的 SQLite；现有 Windows CLI 的 Autoloop 不受影响。任务可用的编译器由镜像安装决定，新增语言工具链应扩展 runner 镜像后重新验证。

Runner 镜像包含 Codex CLI **0.167.0**，下载归档经过 SHA-512 校验，运行时路径为 `/opt/codex/bin/codex`。Codex 账户资料单独保存在 `/data/codex`，随 Runner 数据备份；不会读取办公室电脑的 Codex 凭据。升级 CLI 必须同步协议验证，不能只替换二进制。

## 本地验收

构建两镜像时使用 `local-validation` 标签，然后执行隔离的 Compose 演练：

```sh
docker build -f deploy/cloud/Dockerfile.check -t agentdesk-cloud-check:local .
node deploy/cloud/check-compose.mjs
```

演练采用生产 Compose 中的非 root、只读根目录、资源限制和无额外 capability 设置，使用独立命名卷及内部网络，不发布宿主端口。本地 TLS SMTP 测试服务接收验证码，HTTPS 代理转发真实登录请求；随后重启服务、停止写入、运行 age 加密备份、恢复到新目录、新建容器并验证原会话、项目、未提交文件和 Git 凭据解密。测试完成后清理本次创建的容器和卷。测试占用 `172.29.197.0/24`，如与现有 Docker 网络冲突，应先更改测试脚本及测试初始化脚本的地址。

`Dockerfile.check` 只给演练增加 age，不是生产镜像。`test-backup.py` 另外覆盖坏校验和、路径穿越、链接及特殊文件拒绝。上述结果不替代真实邮箱投递和真实手机网络测试。

## 初始化与启动

在服务器运行 `preflight.sh`，检查架构、可用资源、Docker、现有端口与网络。建议 Docker Engine >= 28；从外网实测 17892、17893 不可访问。不要挂载宝塔网站目录、宿主根目录或 Docker socket。

```sh
sha256sum -c agentdesk-2026-11-09.tar.sha256
docker load -i agentdesk-2026-11-09.tar
sudo python3 deploy/cloud/initialize.py --root /srv/agentdesk \
  --origin https://agent.example.com --owner owner@example.com \
  --smtp-host smtp.example.com --smtp-user owner@example.com --release 2026-11-09
cd /srv/agentdesk/deploy
sudo docker compose config --quiet
sudo docker compose up -d --wait
```

初始化只接受全新目录，交互读取 SMTP 密码。使用专用 UID 10001／10002，文件组 10000。生成并一致配置两端 owner ID；升级时必须保留原 ID、主密钥、OTP pepper 和数据库。SMTP 默认 465 TLS；使用 587 STARTTLS 时修改 `config/gateway.env` 的端口和 `SMTP_SECURE=false`。自定义模型地址应同时配置两端的 `PROVIDER_ALLOWED_HOSTS`。

默认 Docker 子网为 `172.30.98.0/24`。如果冲突，同时修改 `deploy/.env` 的 `AGENTDESK_SUBNET`、`AGENTDESK_BRIDGE` 和 `gateway.env` 中 `TRUSTED_PROXY_CIDRS` 为该桥接网关的 `/32`。禁止配置任意网段代理信任。

在宝塔新增独立 HTTPS 站点，把 `nginx.conf.example` 放进其 server 块，并将 HTTP 重定向到 HTTPS。Nginx 覆盖代理头，禁用 SSE 缓冲，转发设备 WebSocket。检查配置后重载。网关只映射 `127.0.0.1:17892`；runner 不映射宿主端口。

```sh
node /srv/agentdesk/deploy/smoke.mjs https://agent.example.com
sudo docker compose ps
```

随后在手机完成邮箱登录、模型配置／主动测试、项目任务与审批、断线回放、选定文件 commit、单独 push、电脑配对／撤销及取回。API fixtures 和单元测试不能代替真实 SMTP、模型与手机验收。Codex 只有在执行器状态显示可用并完成真实验证后才算交付。

上线时把容器健康状态和域名烟测接入现有宝塔计划任务／监控告警，并配置每日加密备份与异地副本。`restart: unless-stopped` 会恢复退出的进程，不会自动重启仅被标为 `unhealthy` 的容器；收到告警后先查日志、磁盘和活动任务，再决定重启。首次部署应验证告警能送达，不能把配置了 healthcheck 当作已经配置了自动恢复。

## 在 Docker 26 / 27 上使用独立桥接网络

默认部署仍要求 Docker 28 或更新版本。必须复用旧 Docker 宿主时，可在初始化命令中添加 `--network-mode bridge`：生成的 `.env` 会同时加载 `compose.yaml` 与 `compose.bridge.yaml`，彻底移除宿主端口映射，并将 Nginx 上游改为容器固定地址 `172.30.98.10:3000`。要求 Compose 至少 2.24.4，以支持 `!reset`；不要通过改低版本检查来继续使用旧的 localhost 端口发布方式。

初始化后运行 `sh preflight.sh --bridge /srv/agentdesk/deploy`。该命令校验实际合并后的 Compose 配置，拒绝任何发布端口、宿主网络、特权模式、外部网络或不安全的桥接驱动配置。容器启动后还须检查宿主转发规则、实际无端口发布、Nginx 连通性及外部不可直连，并在实际宿主验证 Node.js、SQLite、Codex 与登录链路。此方式不代表 CentOS 7 恢复官方支持；它仅解决旧 Docker 的端口发布限制。

默认桥接网段必须与现有业务网络不重叠。资源紧张时使用额外 Compose 覆盖文件设置服务内存和 CPU 上限，将其追加到 `COMPOSE_FILE`，并保留原有两个文件。备份与恢复需要一起保留这些部署文件。

`bridge-firewall.sh /srv/agentdesk/deploy` 为固定接口 `ad-cloud` 添加定向的 `DOCKER-USER` 规则，拒绝从其他接口进入 AgentDesk 网段的新转发连接，保留宿主 Nginx 的访问和容器出站连接的回包。应在启动容器前应用，并通过系统服务保证 Docker 或防火墙重启后重新应用。实际验证应包括宿主访问成功、其他网络直连失败以及规则计数增加。运行 Compose 命令时应先进入部署目录，以确保当前版本正确加载 `.env` 中的 `COMPOSE_FILE`。

## 手机初始化项目与执行器

手机“添加项目”接受 GitHub 或 Gitee 的 HTTPS 仓库地址。在“私有仓库访问凭据”填写用户名和仅用于该仓库的 token，保存后输入框清空；服务端将 token 加密存储，并通过 Git 子进程环境传递认证头，仓库 URL 和进程参数不含 token。填写 Git 提交姓名、邮箱并主动导入后，项目才出现在列表中。读取测试只证明可读取，推送权限仍由后续单独审批的真实 push 验证。

手机“设置 → Codex 授权”会在当前宿主开始 OpenAI 设备码登录。授权成功后才能为该宿主选择 Codex。验证码只保留在当前页面内存。原生 Bot 的模型配置与 Codex 账户分别设置。

取回办公室未提交改动时，如果云端缺少源 `sourceHead`，先在办公室项目中预览待推送提交，明确指定临时分支并单独批准推送；再在取回页面展开“云端缺少电脑上的 Git 提交”，输入 `refs/heads/...` 并获取基线，最后重试同一快照。获取只下载对象，不切换当前分支。确认 manifest 后导入到新的工作区，源目录及暂存区保持原样。暂存快照最多保留 24 小时，每小时回收；恢复工作区和幂等记录不会随暂存清理删除。

## 办公室 Windows 连接器

先用当前 CLI 实例添加要授权的项目。手机“公司电脑连接”创建配对码，然后在办公室交互终端执行：

```powershell
agentdesk connect pair --server https://agent.example.com
agentdesk connect status
agentdesk connect install
```

在两端分别核对指纹和项目并确认。`install` 注册当前 Windows 用户登录触发、最低权限的计划任务，并检查同一个 CLI 实例是否需要恢复。锁屏期间可继续工作；注销、睡眠、关机不保证在线。移除自启动使用 `agentdesk connect uninstall`，撤销连接使用 `agentdesk connect revoke` 或手机设备页。

办公室运行 Codex 需要安装已验证的 0.167.0 版本，在启动 CLI 服务前配置 `AGENTDESK_CODEX_BIN` 为其绝对路径。Git 操作需要 Git for Windows；本地 Windows Codex 文件审批烟测使用其 Git Bash。真实协议验证脚本为 `scripts/check-codex-protocol.ts`，使用独立临时 home 和本地 Responses 测试服务，覆盖 start、流事件、命令／文件审批、拒绝、取消和跨进程 resume；不消耗真实模型额度。

## 模型凭证与存储策略

个人 API Key 在桌面端本地配置并由本地执行器使用，不随业务数据上传。升级后，Gateway 和 Runner 默认拒绝远程写入模型 API Key；已有云端密钥继续保留，不会自动迁移到电脑或删除。关闭写入不代表禁用了已有云密钥。

云端无人值守任务若需独立服务凭证，在 `config/gateway.env` 和 `config/runner.env` 两端都显式设置 `ALLOW_SERVER_PROVIDER_CREDENTIALS=true`，重新创建两服务。手机端还需勾选“配置独立服务器服务凭证”，接口请求必须包含 `credentialPurpose: "server-service"`。凭证加密保存在云宿主，手机不持久化密钥；不要填入要求仅留在个人电脑上的 Key。两端任一开关关闭都会拒绝写入。

桌面“设置 → 存储与隐私”管理当前本地 Sidecar；手机或 Web 选择云宿主后，在“设置 → 云宿主存储”管理服务器 Runner 数据目录。仅部署配置中的 owner 可访问云端存储接口；保存策略、生成预览与执行清理要求最近 15 分钟内验证邮箱，写请求同时检查会话 CSRF。若入口未出现，核对 Gateway 与 Runner 均已升级，云宿主在线且健康信息包含 `storage.manage`。办公室宿主和普通成员不提供全宿主管理。

自动清理默认关闭；开启并保存后每小时分批回收已关闭任务的旧事件、轨迹和无引用旧截图。清理需先预览，预览绑定当前登录会话，5 分钟有效且只能使用一次；修改策略使旧预览失效。清理响应丢失时先刷新再重新预览，不能直接重复删除。不会删除工作区、产物、浏览器登录态或密钥；SQLite 删除记录释放可复用页，主文件通常不会立即缩小。

容量页仅统计 Runner 应用数据目录，不包含 Gateway 数据库、工作区、Docker、备份和外部工具缓存，仍须独立监控这些目录。磁盘预留取最小 GiB 和分区百分比的较大值；普通任务及自动化托管每次实际执行前检查应用数据目录与工作区分区。空间不足时不启动模型/工具，托管任务转为 `needs_attention` 并保留检查点；清理或扩容后核实状态，再手动恢复。该检查是启动准入，不能替代文件系统配额或拦截已经运行的任意工具写盘。个人 API Key 的本地默认策略不受此功能影响。

## PostgreSQL 生产部署

当前后端通过异步仓储使用 PostgreSQL 17；桌面执行继续 SQLite。个人 API Key 不随业务数据上传。生产使用 `compose.yaml` + `compose.postgres.yaml`，保留部署原有的网络 / 资源覆盖文件，不能用新 overlay 覆盖并丢弃它们。

`initialize.py` 尚不自动创建 PostgreSQL 角色或密钥。首次部署需由管理员完成以下配置；已有部署禁止重跑初始化或覆盖旧 secret。

1. 将 `compose.postgres.yaml` 复制到服务器部署目录，创建 `data/postgres17` 和受限 `secrets/postgres` 目录，生成独立的 `admin-password` 文件。该密码只用于 PostgreSQL 管理，不提供给应用。
2. 启动独立 PostgreSQL 服务后，在新数据库中创建 `agentdesk_gateway` / `agentdesk_runner` 登录角色，均不授予 SUPERUSER、CREATEDB 或 CREATEROLE。使用交互式 `psql` 的 `\password` 配置随机密码，避免把密码放在命令历史。
3. 管理员创建 `gateway AUTHORIZATION agentdesk_gateway` 和 `runner AUTHORIZATION agentdesk_runner` 两个 schema；撤销 PUBLIC 的数据库 CREATE 和 public schema CREATE 权限。应用只拥有各自 schema，无需数据库级 CREATE。
4. 分别将应用角色的连接串写入 `secrets/gateway/database-url`、`secrets/runner/database-url`，密码按 URL 规则编码。沿用原有受限 secret 文件权限，确保容器 UID 10001 / 10002 可读；不要提交或打印连接串。
5. 在部署 `.env` 中配置独立不可变发布标签，保留原 `DEPLOY_ROOT` 等设置。Gateway 和 Runner 可以分开升级。

```dotenv
COMPOSE_FILE=compose.yaml:compose.postgres.yaml
GATEWAY_POSTGRES_RELEASE=20261112-pg-gateway-v3
RUNNER_POSTGRES_RELEASE=20261112-pg-runner-v2
```

overlay 分别注入 `DATABASE_URL_FILE=/run/secrets/gateway/database-url` / `/run/secrets/runner/database-url` 与 `DATABASE_SCHEMA=gateway` / `runner`。不同时设置 URL 与 URL_FILE。数据库仅在 Docker 私有网络访问，不能映射 5432 到公网。连接池与 PostgreSQL 总连接数应一起调整；当前 PostgreSQL 上限为 30，内存上限 384 MiB。

维护时先进入部署目录，并显式指定全部 Compose 文件。部分 Compose 版本从其他目录调用 `--project-directory` 时不会按预期加载 `COMPOSE_FILE`，可能意外选用旧镜像。

```sh
cd /srv/agentdesk/deploy
docker compose -f compose.yaml -f compose.postgres.yaml config --quiet
docker compose -f compose.yaml -f compose.postgres.yaml up -d --wait
```

如果宝塔直接代理固定容器 IP，必须保留固定 IP 配置；动态分配的地址可能在停启后改变。当前部署另有 `compose.site.yaml` 为 Gateway 固定 `172.30.98.10`，其 `COMPOSE_FILE` 和每次维护的 `-f` 参数均须包含此文件。使用 `compose.bridge.yaml` 的部署还须保留它及其无端口发布配置，不要照抄其他环境的网络设置。

新旧库迁移必须停写、创建一致 SQLite 快照并实际验证备份可恢复，再运行镜像内迁移入口：Gateway 为 `/app/dist/migrate.mjs <snapshot.sqlite> <new-report.json>`；Runner 为 `/app/migrate-runner.mjs <snapshot.sqlite> <new-report.json>`。CLI 使用对应数据库 URL_FILE / schema；Gateway 还需原有完整部署配置。将快照与输出目录挂入一次性迁移容器，避免对运行中的 SQLite 文件直接迁移。目标业务数据必须为空；逐表行数与 canonical SHA-256 验证通过才提交。生产目标非空时禁止盲目重复导入。

Gateway `/health/ready` 与 Runner `/remote-api/v1/health/ready` 均实际查询数据库，正常返回 `database=postgres`；Runner 需要内部共享令牌。切换后还应验证登录鉴权、项目 / 任务读取、审批、事件回放及空闲时重启持久化。不要只检查进程存活。

## PostgreSQL 备份与恢复

将 `postgres-backup.py`、`encrypt-backup.mjs` 安装至 `/srv/agentdesk/ops/`，服务器仅安装 `secrets/backup-recovery.public.pem`；RSA 恢复私钥放在本地与安全备份介质，不能放服务器或 Git。使用 `decrypt-backup.mjs` 恢复时需要同名 `.encryption.json`。

```sh
sudo python3 /srv/agentdesk/ops/postgres-backup.py --root /srv/agentdesk --keep 14
```

脚本同时 dump `gateway` / `runner`，在临时库实际 `pg_restore` 验证成功后删除验证库；同时通过 SQLite Online Backup API 备份 Runner 宿主配置，并保存部署配置和 secrets。三部分全部 AES-256-GCM 加密，随机密钥通过 RSA-OAEP-SHA256 包装。每个快照独立一致，不是跨 PostgreSQL / SQLite 的同一时点。只轮换成功的每日备份，保留人工和迁移备份。线上 cron 在服务器时间每天 03:17 运行，保留 14 份。

**文件范围：该脚本不备份工作区、产物文件、Codex home 或整个 Docker 目录。** 这些需要独立文件备份与异地副本。容量页目前也不统计 PostgreSQL 和备份目录，必须单独监控磁盘及备份成功率。

恢复时先在隔离环境运行：

```sh
node deploy/cloud/decrypt-backup.mjs business.dump.enc /safe/recovery.private.pem /safe/new-business.dump
pg_restore --exit-on-error --dbname=NEW_ISOLATED_DATABASE /safe/new-business.dump
```

先准备匹配 PostgreSQL 版本、原角色与所有权，核对 manifest 和业务表，再停写备份生产库、切换连接配置并验收。恢复工具拒绝覆盖已有输出。配置包应在新的受限目录解密解压；网络、secret 权限与镜像也需要一起恢复。数据库开始接受新写入后，不能只切回旧 SQLite / 旧镜像而不处理新增数据。

## 旧 SQLite 与文件备份和恢复

以下旧工具使用 `age`，可以保存文件与原 SQLite 数据，**不包含 PostgreSQL 数据，不能单独用于当前生产业务库恢复**。收件公钥可放服务器，解密私钥保存在另一安全位置。备份脚本会短暂停止两服务，以一致保存 SQLite 的 DB／WAL／SHM、项目、主密钥、凭据、设备配对和 Codex home；完成或失败后重新启动原容器。先确认没有需要保留的活动任务。

```sh
sudo bash /srv/agentdesk/deploy/backup.sh /srv/agentdesk age1YOUR_PUBLIC_KEY /safe/agentdesk.age
sudo python3 /srv/agentdesk/deploy/restore.py --backup /safe/agentdesk.age \
  --identity /safe/age-identity.txt --destination /srv/agentdesk-restored
```

将加密备份及校验文件另存异地。恢复只写全新目录，拒绝路径穿越、越界链接与特殊文件。先用备份对应镜像，检查 SQLite `PRAGMA integrity_check`，确保两个数据库和主密钥同属一次备份。若进行隔离恢复演练，使用独立 Compose project、端口、子网；避免同时启动同一配对身份。确认后切换 Nginx 并执行烟测和真实登录。

## 升级与回滚

升级前完成备份，记下原镜像标签／digest，载入新镜像后修改 `deploy/.env` 的版本并执行 `docker compose up -d --wait`。检查日志、健康、登录、项目与任务状态。

迁移只能向前。新版已修改数据库后，不能只换回旧镜像：停止新容器，将升级前的完整加密备份恢复到新目录，使用原标签启动并切换代理。保留失败目录用于核对。不得删除持久卷或在源仓库执行 reset／clean 来处理回滚。
