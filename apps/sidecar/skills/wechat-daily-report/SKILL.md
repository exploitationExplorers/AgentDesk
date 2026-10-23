---
name: wechat-daily-report
description: 基于本机已登录微信的本地库生成群聊日报/成员个人日报长图（话痨榜、AI 摘要、report.png）
version: 1.0.0
agents: [code, orchestrator]
triggers: [微信, 群聊日报, 微信日报, 群日报, 聊天日报, 话痨榜, 成员日报]
allowed_tools: [shell.run, fs.read, fs.write, fs.glob]
---

# 微信群聊日报

目标：解密本机微信本地库 → 分析指定群 → 你生成 AI 文案 JSON → 渲染 `report.png` 长图。

`skills.load` 返回的 **`dir`** 即本技能根目录。后续所有 `shell.run` 的 `cwd` 必须设为该 `dir`。

依赖：Python 3.10+、`pip install jieba jinja2 pillow`；系统需有 Chrome/Edge（或 Playwright）。微信须已登录运行；**首次提取密钥需管理员权限**。

运行产物（`decrypted/`、`report.png`、密钥）写在 `dir` 下，已由 `.gitignore` 忽略，禁止提交仓库。若 `dir` 只读，先把本技能复制到 `%APPDATA%\AgentDesk\skills\wechat-daily-report`，重启 sidecar 后再 load。

## 一次性准备

若 `dir/decrypted/` 不存在或群列表为空：

```text
python scripts/decrypt_wechat.py
python scripts/list_wechat_groups.py
```

Windows 提取密钥需管理员；若已有 `decrypted/all_keys.json`，重新解密无需管理员。

## 群聊日报（主流程）

严格按序，**不可跳过第 3 步**。

### 1. 确认群名

```text
python scripts/list_wechat_groups.py
```

从输出拿到**准确显示名**（含 emoji），不要猜。

### 2. 分析

```text
python scripts/analyze_chat.py --chatroom "<群名>" --date YYYY-MM-DD --output-stats stats.json --output-text simplified_chat.txt
```

解密库已是最新时可加 `--skip-refresh`。日期默认今天；用户说「昨天」则用昨天的日期。

产物：`stats.json`、`simplified_chat.txt`（或分块 `simplified_chat_*.txt`）。

### 3. 生成 `ai_content.json`（必须由你完成）

用 shell 读取（cwd=`dir`）：

- `references/ai_prompt.md`
- `stats.json`
- `simplified_chat*.txt`（路径见 `stats.json` 的 `raw_text_paths`，若有）

按 `ai_prompt.md` 产出**合法 JSON 对象**，写入 `ai_content.json`（UTF-8，无 Markdown 围栏）。

约束：

- `talker_profiles` 的 key 必须与 `stats.json` → `top_talkers[].name` **完全一致**
- 风格：幽默、玩梗；不要编造聊天里没有的事实

写入示例（PowerShell，cwd=`dir`）：

```powershell
@'
{ ...合法 JSON... }
'@ | Set-Content -Encoding utf8 ai_content.json
```

### 4. 渲染长图

仅在 `ai_content.json` 已存在后：

```text
python scripts/generate_report.py --stats stats.json --ai-content ai_content.json --output report.png --clean-temp
```

完成后回报 **`dir/report.png`**（及 `report.html`）的绝对路径；可用资源管理器打开。`--clean-temp` 会删中间文件，勿再读 `stats.json`。

## 成员个人日报（可选）

1. `python scripts/analyze_member.py --chatroom "<群名>" --list-members --date YYYY-MM-DD` → 记下 `wxid`
2. `python scripts/analyze_member.py --chatroom "<群名>" --member-id <wxid> --date YYYY-MM-DD --output-stats member_stats.json --output-text member_chat.txt`
3. 读 `references/member_prompt.md` + 上述产物 → 写入 `member_ai_content.json`
4. `python scripts/generate_member_report.py --stats member_stats.json --ai-content member_ai_content.json --output member_report.png --clean-temp`

## 约束

- 最终交付必须是 `.png`，不要停在 HTML
- 没有 `ai_content.json` / `member_ai_content.json` 时禁止渲染
- `decrypted/`、`all_keys.json`、头像缓存属隐私，**禁止**复制到项目仓库或对外发送原文聊天记录；只交付日报图与口头摘要
- 解密/分析失败时说明原因（微信未运行、无管理员、密钥过期），建议重跑 `decrypt_wechat.py`，不要改用其它破解方式
