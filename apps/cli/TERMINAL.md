# 终端外观与动效

AgentDesk 可以控制文字、颜色、图标、选项状态和动画。字体、字号、字距、背景和光标样式由 Windows Terminal、VS Code 终端或其他终端软件负责。CLI 不会修改系统字体或用户的终端配置。

## 推荐字体

首选 [Maple Mono NF CN](https://github.com/subframe7536/maple-font)：开源等宽字体，提供中文、连字和 Nerd Font 图标，中英文宽度按 2:1 配合。下载官方 Releases 中的 NF CN 字体包并按说明安装；在字体安装后选择它。也可以使用已安装的 Cascadia Code，或 [Sarasa Mono SC](https://github.com/be5invis/Sarasa-Gothic)。

字体安装和系统设置可能写入 C 盘，请根据自己的空间情况决定；本项目没有自动下载或安装字体。

Windows Terminal：打开「设置 → 配置文件 → 当前使用的 PowerShell → 外观」，将字体设为 `Maple Mono NF CN`，字号建议 14，选择深色配色方案。界面中没有该字体时，先确认字体已安装，并完全重启终端。Emoji 通常由系统的 Emoji 字体回退显示，字体自身并不保证彩色表情。

VS Code：打开「设置 → 搜索 terminal font family」，填入下面的字体列表，并将字号调整为 14：

```json
{
  "terminal.integrated.fontFamily": "'Maple Mono NF CN', 'Cascadia Code', monospace",
  "terminal.integrated.fontSize": 14,
  "terminal.integrated.lineHeight": 1.2,
  "terminal.integrated.cursorBlinking": true
}
```

光标闪烁是终端设置，与 CLI 的欢迎和步骤动效独立。建议终端宽度至少 80 列；更窄时文字会换行。

## 预览和控制

在仓库根目录运行：

```powershell
pnpm cli:preview
```

预览使用与实际 CLI 相同的欢迎、选项和输入组件。无需后台服务，不连接真实模型，不读取或保存模型配置，也不需要真实 API Key。演示加载动画会明确标记为「演示」。

实际初始化仍使用 `pnpm cli init`。已有配置时选择「重新配置模型」可以重新进入向导。

欢迎标题采用短暂的渐变流光，步骤完成后以移动箭头连接下一步，加载动画仅在操作进行期间播放。方向键选择即时更新高亮项；菜单确认后收起。终端动效按字符格刷新，不会像网页一样对字体或布局进行像素级缩放。

```powershell
pnpm cli:preview --no-motion
pnpm cli:preview --no-emoji
pnpm cli init --no-motion
```

- `--no-motion`：关闭欢迎、步骤和加载动效，保留方向键交互。
- `--no-emoji`：关闭表情图标，保留文字和简单符号。
- `--no-color` 或 `NO_COLOR`：关闭颜色。
- `--plain`：关闭颜色、动效和表情，使用编号菜单。
- `AGENTDESK_REDUCED_MOTION=1`：关闭动效。
- `AGENTDESK_NO_EMOJI=1`：关闭表情图标。
- `CI=true` 或 `ACCESSIBLE=1`：自动关闭本项目的欢迎、步骤和加载动效。

管道和 `TERM=dumb` 自动关闭颜色、动效与表情。JSON / NDJSON 命令仍只输出原有机器协议。

## 参考项目

- [Vite+ prompts](https://github.com/voidzero-dev/vite-plus/tree/main/packages/prompts)：当前使用的交互组件。
- [Clack](https://github.com/bombshell-dev/clack)：提示状态、收起后的结果和键盘交互。
- [Gum](https://github.com/charmbracelet/gum)、[Huh](https://github.com/charmbracelet/huh)：参考欢迎文案、图标和终端流程反馈；没有安装它们的运行时。
