---
name: qa-regression
description: 使用 AgentDesk 的 Playwright 浏览器会话执行自然语言端到端回归测试，输出步骤、断言、失败证据和结果报告
version: 1.0.0
agents: [orchestrator, code]
triggers: [回归测试, 端到端测试, e2e, qa, Playwright, 验收测试, 浏览器测试]
allowed-tools: [browser.*, fs.*, shell.run, environment.inspect, tasks.ask_user]
isolate-tools: true
user-invocable: true
---

# QA Regression

把用户给出的验收目标转成一次可复现的浏览器端到端回归测试。使用 AgentDesk 已提供的 Playwright 浏览器工具完成测试，不声称使用或依赖 qa-agent、`@bug0/ai` 或其他未实际配置的外部服务。

## 测试前

1. 确认目标 URL、运行环境、登录方式、测试账号和前置数据。信息不足且会阻塞测试时，用 `tasks.ask_user` 询问；不要猜测账号、验证码或业务数据。
2. 使用固定且有意义的 `sessionId` 调用 `browser.open`，以便复用同一浏览器会话和登录 Cookie。打开后立即用 `browser.snapshot` 检查 URL、标题和页面状态。
3. 不自动安装依赖、不写入 API Key、不假设 Redis 或其他外部基础设施。若用户要求生成 Playwright 测试代码，才使用 `shell.run` 执行目标项目已有的测试命令。

## 执行与断言

- 将自然语言步骤拆成编号步骤，用 `browser.act` 执行 goto、click、fill、press、wait 或 screenshot。
- 关键操作后用 `browser.snapshot` 验证可见文本、URL、标题、表单状态和业务结果；断言必须基于实际页面证据。
- 登录、验证码、审批、购买、删除、发布和其他不可逆写操作遵守现有权限策略。遇到验证码或需要人工接管时使用 `browser.reveal`，不要绕过安全控制。
- 发现页面元素变化时，根据当前 snapshot 重新定位并重试有限次数，保留原失败步骤；不要无限重试或掩盖真实失败。
- 测试结束后按需调用 `browser.close`，不要关闭用户正在使用且未由本轮创建的会话。

## 报告

最终报告包含：通过或失败结论、测试环境、执行步骤、每一步的断言、关键证据（snapshot 或截图）、失败时的 URL/标题/最近步骤/错误信息，以及未覆盖的风险。失败截图应通过浏览器工具留下可追踪证据。

只参考 qa-agent 的自然语言步骤、断言和有限重试思路，不复制其源码或许可证内容。除非用户明确要求，否则不要把回归测试改造成持续集成配置，也不要执行超出测试范围的写操作。
