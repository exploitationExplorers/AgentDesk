import { createServer } from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { claimState, publishState, removeOwnedState, type CliState } from "../../src/state.js";

const home = process.env.AGENTDESK_CLI_HOME;
assert.ok(home);
assert.ok(process.env.AGENTDESK_CLI_INSTANCE);
assert.ok(process.env.AGENTDESK_CLI_TOKEN);
const state: CliState = {
  schemaVersion: 1,
  instanceId: process.env.AGENTDESK_CLI_INSTANCE,
  token: process.env.AGENTDESK_CLI_TOKEN,
  pid: process.pid,
  port: 0,
  mode: process.env.AGENTDESK_CLI_MODE === "foreground" ? "foreground" : "background",
  version: "fixture",
  startedAt: new Date().toISOString(),
};
claimState(home, state);
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.headers["x-agentdesk-token"] !== state.token) {
    res.writeHead(401);
    res.end("{}");
    return;
  }
  if (req.url === "/api/cli/instance") {
    res.end(JSON.stringify({ instanceId: state.instanceId, pid: state.pid, version: "fixture" }));
    return;
  }
  if (req.url === "/api/fixture/process-tree" && req.method === "POST") {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({pid:process.pid,descendant:child.pid})); setInterval(()=>{},1000)",
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    child.stdout.once("data", (data) => res.end(data));
    child.once("error", () => {
      res.writeHead(500);
      res.end("{}");
    });
    return;
  }
  if (req.url === "/api/cli/shutdown" && req.method === "POST") {
    res.end('{"stopping":true}');
    setTimeout(() => {
      server.closeAllConnections();
      server.close(() => {
        removeOwnedState(home, state.instanceId);
        process.exit(0);
      });
    }, 20);
    return;
  }
  res.writeHead(404);
  res.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
if (process.env.AGENTDESK_PARENT_STDIN === "1") {
  process.stdin.resume();
  process.stdin.once("end", () => {
    server.closeAllConnections();
    server.close(() => {
      removeOwnedState(home, state.instanceId);
      process.exit(0);
    });
  });
}
const address = server.address();
assert.ok(address && typeof address === "object");
state.port = address.port;
try {
  await publishState(home, state);
  console.info("fixture ready");
} catch (error) {
  server.closeAllConnections();
  server.close();
  removeOwnedState(home, state.instanceId);
  throw error;
}
