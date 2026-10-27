/** 使用真实终端组件预览交互，不启动服务，也不读取或保存用户配置。 */
import { setTimeout as delay } from "node:timers/promises";
import { parseCommand } from "../src/args.mjs";
import { question, select } from "../src/terminal.mjs";
import { configureUi, createUi } from "../src/ui.mjs";

async function preview() {
  const { values } = parseCommand(["init", ...process.argv.slice(2)]);
  configureUi(values);
  const ui = createUi();
  await ui.welcome("终端体验预览");
  ui.note("演示模式 · 不连接模型 · 不保存配置");
  await select(`${ui.icon("🔌")}选择模型协议`, [
    { label: "OpenAI Compatible", value: "openai", hint: "OpenAI、DeepSeek、Ollama 等" },
    { label: "Anthropic Messages", value: "anthropic", hint: "Claude API" },
  ]);
  await ui.advance(1, 4, "协议已选择，接下来填写地址");
  await question(`${ui.icon("🔗")}体验地址输入`, { defaultValue: "https://api.example.com/v1" });
  await ui.advance(2, 4, "地址已填写，选择你的模型");
  await question(`${ui.icon("🧠")}体验模型输入`, { defaultValue: "demo-model" });
  await ui.advance(3, 4, "模型已填写，最后体验隐藏输入");
  await question(`${ui.icon("🔐")}输入任意测试文字`, {
    secret: true,
    placeholder: "演示输入，不保存；也可以直接按 Enter",
  });
  await ui.advance(4, 4, "输入演示完成");
  await ui.task("预览加载动画（演示）", () => delay(ui.motion ? 900 : 0));
  ui.outro("预览完成，去创造你的下一件作品吧。");
}

await preview().catch((error) => {
  if (error.message === "已取消配置。") createUi().outro("预览已退出。", { cancelled: true });
  else createUi().error(error.message);
  process.exitCode = 1;
});
