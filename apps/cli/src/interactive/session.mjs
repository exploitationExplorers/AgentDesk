import { render } from "ink";
import { createElement } from "react";
import { apiRequest } from "../client.mjs";
import { AGENTS } from "../commands.mjs";
import { runningState } from "../lifecycle.mjs";
import App from "./App.jsx";
import { resolveAccessibility } from "./theme.mjs";

/** 打开持久化交互式会话：校验 Agent、可选回放历史、渲染 Ink 组件树直到用户退出。 */
export async function runInteractiveChat(home, workerPath, values) {
  const state = await runningState(home, workerPath);
  if (values.agent && !AGENTS.includes(values.agent))
    throw new Error(`--agent 可选值：${AGENTS.join(", ")}`);
  const theme = resolveAccessibility({
    tty: Boolean(process.stdout.isTTY),
    env: process.env,
    settings: values,
  });
  let initialMessages;
  if (values.conversation) {
    const response = await apiRequest(
      state,
      `/conversations/${encodeURIComponent(values.conversation)}/messages`,
    );
    initialMessages = await response.json();
  }
  const { waitUntilExit } = render(
    createElement(App, {
      state,
      agent: values.agent,
      conversationId: values.conversation,
      initialMessages,
      theme,
    }),
  );
  await waitUntilExit();
}
