#!/usr/bin/env node
import { parseCommand } from "../args.js";
import { cliHome } from "../state.js";
import { configureUi } from "../ui.js";
import { teamCommand } from "./commands.js";

const help = `AgentDesk 团队连接端

agentdesk-team pair --server https://你的团队地址
agentdesk-team read
agentdesk-team say "项目讨论"
agentdesk-team work --repo 仓库根目录 --runner-config 本机配置.json

每个项目可通过 --data-dir 指定独立连接目录。
配对码在交互终端输入；模型凭据留在本机。
`;

try {
  const argv = process.argv.slice(2);
  if (argv[0] === "team") argv.shift();
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.info(help);
  } else {
    const { positionals, values } = parseCommand(["team", ...argv]);
    configureUi(values);
    await teamCommand(cliHome(values["data-dir"]), positionals[0]!, positionals.slice(1), values);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "团队连接未完成");
  process.exitCode = 1;
}
