import { render } from "ink";
import { createElement } from "react";
import {
  AgentName,
  type AgentModelBinding,
  type ChatMessage,
  type Provider,
} from "@agentdesk/shared";
import type { CliValues } from "../args.js";
import { apiRequest } from "../client.js";
import { AGENTS } from "../commands.js";
import { runningState } from "../lifecycle.js";
import App from "./App.js";
import { resolveAccessibility } from "./theme.js";
import { registerWorkspace } from "../workspace.js";
import { nextCommand } from "../ui.js";
import { defaultModelOption } from "./slash-commands.js";

/** 打开持久化交互式会话：校验 Agent、可选回放历史、渲染 Ink 组件树直到用户退出。 */
export async function runInteractiveChat(
  home: string,
  workerPath: string,
  values: CliValues,
  version = "0.1.0",
) {
  const state = await runningState(home, workerPath);
  if (values.agent && !AGENTS.includes(values.agent))
    throw new Error(`--agent 可选值：${AGENTS.join(", ")}`);
  const theme = resolveAccessibility({
    tty: Boolean(process.stdout.isTTY),
    env: process.env,
    settings: values,
  });
  let initialMessages: ChatMessage[] | undefined;
  const workspace = await registerWorkspace(state);
  const [providers, bindings] = await Promise.allSettled([
    apiRequest<Provider[]>(state, "/providers").then((r) => r.json()),
    apiRequest<AgentModelBinding[]>(state, "/agent-bindings").then((r) => r.json()),
  ]);
  const selected = defaultModelOption(
    providers.status === "fulfilled" ? providers.value : [],
    bindings.status === "fulfilled" ? bindings.value : [],
    values.agent ? AgentName.parse(values.agent) : "orchestrator",
  );
  if (values.conversation) {
    const response = await apiRequest<ChatMessage[]>(
      state,
      `/conversations/${encodeURIComponent(values.conversation)}/messages`,
    );
    initialMessages = await response.json();
  }
  const { waitUntilExit } = render(
    createElement(App, {
      state,
      agent: values.agent ? AgentName.parse(values.agent) : undefined,
      conversationId: values.conversation,
      initialMessages,
      theme,
      model: selected?.model,
      version,
      cwd: process.cwd(),
      workspace,
      workbenchCommand: nextCommand("web", home),
    }),
    { exitOnCtrlC: false, incrementalRendering: true },
  );
  await waitUntilExit();
}
