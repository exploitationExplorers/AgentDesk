# Changelog

本文件记录 AgentDesk 产品版本的可见变化，采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 分类和 [SemVer](https://semver.org/lang/zh-CN/) 预发布版本号。CLI 安装包独立版本化，不能由产品版本推断 npm 包、桌面安装包或网站已经更新。

## [Unreleased]

后续改动从此处开始记录，发布时移动到对应版本并填写日期。

## [1.0.0-alpha.1] - 2026-11-18

首个产品 Alpha 源码版本，展示名为 **v1.0.0 (Alpha)**，对应 tag `v1.0.0-alpha.1`。

### Added

- 从 Lancer 独立组件复用 `@agentdesk/light-ui`，保留 MIT 许可和来源：真实执行事件触发同色 SVG 光线，运行节点显示细描边。
- 编码协作图接入工具、结果和交付事件；团队任务面板展示“成员本机 → 当前任务 → 文件与检查”流向，支持暂停、页面隐藏暂停与减少动态效果。
- [Lancer 技术研究](research/lancer-architecture.md)：依赖、pi Agent 架构、状态所有权、worktree、Skills、扩展和迁移取舍。
- 产品版本一致性检查 `pnpm release:check` 与干净提交上的 annotated tag 命令 `pnpm release:tag`。

### Fixed

- 群聊行内代码在浅色气泡中出现黑底黑字的问题，改善代码块、列表、段落和长回复的阅读宽度。
- 对模型生成的中文加粗末尾空格进行受限兼容处理，避免显示字面量 `**`；代码内容保持原样。
- 光线按事件 ID 去重，加载历史记录和暂停后恢复不补放历史事件；组件卸载清理图层。

### Included in this source baseline

- 多 Agent 群聊、引用与点名、调研／核验／总结和用户拍板。
- 团队项目邀请、各自配对 Codex／Claude Code／自定义 Agent、网页领取／撤回／停止／重试、本机独立 worktree、交付与负责人验收。
- 团队执行事件接口与面板：本机阶段上报；可选 `shareExecution` 共享可见回复、工具与检查输出，过滤常见凭据格式，保留最近 240 条记录。
- 轻量团队连接端源码构建版本 `0.1.2-preview.20261118`，包含执行事件上报；完整 CLI npm 包保持独立发行流程。
- 本机工作台、持久化编码任务、审批、项目与文件差异、自动化、学习和面试题能力。

### Alpha limitations

- 此条目记录源码版本。npm 包、签名桌面安装包与服务器部署各自有独立的构建和验证流程；创建 tag 不会自动发布这些产物。
- 团队网页依赖成员电脑联网并运行执行器；模型登录留在本机。详细输出共享需显式开启，过滤不能识别所有业务秘密。
- 普通群聊和 @ 不会自动启动朋友的 Agent。任务执行与工具审批仍在本机确认；交付不自动合入主分支或部署。
- 任务租约和 Git worktree 不是操作系统沙箱。当前团队站使用项目会话，尚无通用账号恢复系统。
- 本轮浏览器与本地协议测试不能证明所有真实模型服务、完整 Windows 安装包或 macOS／Linux 原生行为均已验证。桌面自动更新地址仍需发布者配置。

## CLI 历史

历史 tag `cli-v0.1.0`、`cli-v0.1.1` 属于 CLI 发行线。它们早于产品 Alpha 版本，不重写或重打这些 tag；CLI 发布流程见 [CLI 文档](apps/cli/README.md#发行验证)。
