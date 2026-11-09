import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodexAppServer, type CodexRpc } from "../packages/integrations/src/codex/app-server";

// 使用真实、固定版本 CLI 和本地 Responses 测试服务，不需要真实账号或模型额度。
const binary = process.argv[2];
assert(binary, "Pass the fixed Codex executable path");
const home = await mkdtemp(join(tmpdir(), "agentdesk-codex-smoke-"));
const workspace = join(home, "workspace");
await mkdir(workspace);
let requests = 0;
let phase = "text";
let toolIssued = false;
const approvals: string[] = [];
const server = createServer(async (req, res) => {
  if (!req.url?.endsWith("/responses")) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests++;
  const command =
    process.platform === "win32"
      ? phase === "patch"
        ? "apply_patch @'\n*** Begin Patch\n*** Add File: patch.txt\n+patch verified\n*** End Patch\n'@"
        : phase === "cancel"
          ? "Start-Sleep -Seconds 30"
          : `Set-Content -LiteralPath ${phase === "deny" ? "denied.txt" : "command.txt"} -NoNewline -Value 'command verified'`
      : phase === "patch"
        ? "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: patch.txt\n+patch verified\n*** End Patch\nPATCH"
        : phase === "cancel"
          ? "sleep 30"
          : `printf 'command verified' > ${phase === "deny" ? "denied.txt" : "command.txt"}`;
  const callTool = phase !== "text" && !toolIssued;
  if (callTool) {
    assert(body.tools.some((t: { name: string }) => t.name === "exec_command"));
    toolIssued = true;
  }
  const patchTool = body.tools?.find((tool: { name?: string }) => tool.name === "apply_patch");
  const item =
    callTool && phase === "patch" && patchTool?.type === "custom"
      ? {
          id: `patch_${requests}`,
          call_id: `patch_call_${requests}`,
          type: "custom_tool_call",
          status: "completed",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Add File: patch.txt\n+patch verified\n*** End Patch",
        }
      : callTool
        ? {
            id: `fc_${requests}`,
            call_id: `call_${requests}`,
            type: "function_call",
            status: "completed",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: command,
              ...(process.platform === "win32" && phase === "patch"
                ? {
                    shell: "C:/Program Files/Git/bin/bash.exe",
                    cmd: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: patch.txt\n+patch verified\n*** End Patch\nPATCH",
                  }
                : {}),
              workdir: workspace,
              yield_time_ms: 1000,
              max_output_tokens: 2000,
            }),
          }
        : {
            id: `msg_${requests}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Protocol verified.", annotations: [] }],
          };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of [
    {
      type: "response.created",
      response: { id: `resp_${requests}`, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    ...(!callTool
      ? [
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            item_id: item.id,
            delta: "Protocol verified.",
          },
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${requests}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
await writeFile(
  join(home, "config.toml"),
  `model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local protocol fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
);
let rpc: CodexRpc | undefined;
async function turn(threadId: string, mode = "text") {
  phase = mode;
  toolIssued = false;
  rpc!.onRequest = async (request) => {
    approvals.push(request.method);
    return { decision: mode === "deny" ? "decline" : "accept" };
  };
  let done!: (value: unknown) => void;
  const completed = new Promise<unknown>((resolve) => {
    done = resolve;
  });
  const events: string[] = [];
  const unsubscribe = rpc!.subscribe((event) => {
    if (event.params.threadId !== threadId) return;
    events.push(event.method);
    if (
      mode === "cancel" &&
      event.method === "item/started" &&
      (event.params.item as { type?: string })?.type === "commandExecution"
    ) {
      void rpc!.request("turn/interrupt", { threadId, turnId: event.params.turnId });
    }
    if (event.method === "turn/completed") done(event.params.turn);
  });
  const timeout = setTimeout(() => done({ status: "timeout" }), 30_000);
  try {
    await rpc!.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Reply with Protocol verified.", text_elements: [] }],
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    assert.equal(
      ((await completed) as { status: string }).status,
      mode === "cancel" ? "interrupted" : "completed",
    );
    assert(events.includes("item/completed"));
    assert(events.includes("turn/started"));
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
}
try {
  rpc = await openCodexAppServer(binary, home);
  const created = await rpc.request<{ thread: { id: string } }>("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });
  await turn(created.thread.id);
  await rpc.close();
  rpc = await openCodexAppServer(binary, home);
  const resumed = await rpc.request<{ thread: { id: string } }>("thread/resume", {
    threadId: created.thread.id,
    excludeTurns: true,
    cwd: workspace,
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });
  assert.equal(resumed.thread.id, created.thread.id);
  await turn(resumed.thread.id);
  assert.equal(requests, 2);
  {
    await turn(resumed.thread.id, "command");
    assert.equal(await readFile(join(workspace, "command.txt"), "utf8"), "command verified");
    assert(approvals.includes("item/commandExecution/requestApproval"));
    await turn(resumed.thread.id, "deny");
    await assert.rejects(access(join(workspace, "denied.txt")));
    await turn(resumed.thread.id, "patch");
    assert.equal(await readFile(join(workspace, "patch.txt"), "utf8"), "patch verified\n");
    assert(approvals.includes("item/fileChange/requestApproval"));
    await turn(resumed.thread.id, "cancel");
  }
  console.info(
    "Codex real CLI: start, streamed turn, restart, persisted resume, command/file approvals, denial and cancellation passed (local model fixture)",
  );
} catch (error) {
  console.error("Codex protocol phase failed:", phase, error);
  throw error;
} finally {
  await rpc?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch((error) =>
    console.warn("Temporary fixture cleanup failed:", home, (error as NodeJS.ErrnoException).code),
  );
}
