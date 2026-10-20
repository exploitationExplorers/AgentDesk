---
name: project-triage
description: 跨平台项目巡检：汇总所有项目的未提交改动、未推送提交、待处理 PR/MR
version: 1.0.0
agents: [project, orchestrator]
triggers: [巡检, 项目状态, 哪些项目, 待处理]
allowed_tools: [projects.list, projects.status, projects.activity]
---

# 项目巡检

1. `projects.list` 获取全部项目。
2. 优先关注：`dirtyFiles > 0`（有未提交改动）、`ahead > 0`（未推送）、`behind > 0`（需要拉取）。
3. 对需要关注的项目调用 `projects.activity` 查看开放的 PR/MR，按平台（GitHub / Gitee / GitLab）分组。
4. 输出一张清单：项目 | 平台 | 状态 | 建议动作。最后给出今天最应该先处理的 1-3 件事。
