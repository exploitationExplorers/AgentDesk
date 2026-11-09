import { readFileSync } from "node:fs";

const runner = process.argv[2] === "runner";
const response = await fetch(
  runner ? "http://127.0.0.1:17893/remote-api/v1/health" : "http://127.0.0.1:3000/health/live",
  {
    headers: runner
      ? {
          "x-agentdesk-remote-token": readFileSync(
            process.env.REMOTE_SHARED_TOKEN_FILE,
            "utf8",
          ).trim(),
        }
      : undefined,
    signal: AbortSignal.timeout(4000),
    redirect: "error",
  },
);
if (!response.ok) process.exit(1);
