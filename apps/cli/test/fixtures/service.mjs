import { createServer } from "node:http";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimState, removeOwnedState } from "../../src/state.mjs";

const home = process.env.AGENTDESK_CLI_HOME;
const state = {
  schemaVersion: 1,
  instanceId: process.env.AGENTDESK_CLI_INSTANCE,
  token: process.env.AGENTDESK_CLI_TOKEN,
  pid: process.pid,
  port: 0,
  mode: "background",
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
server.listen(0, "127.0.0.1", () => {
  state.port = server.address().port;
  const temp = join(home, "fixture-ready.tmp");
  writeFileSync(temp, JSON.stringify(state));
  renameSync(temp, join(home, "service.json"));
  console.info("fixture ready");
});
