import { ReachChannelError, type ReachFetchResponse } from "./types";

export function checkReachResponse(response: ReachFetchResponse, provider: string): void {
  const { status, headers = {} } = response;
  const limited =
    status === 429 ||
    (status === 403 &&
      (headers["x-ratelimit-remaining"] === "0" ||
        /rate.?limit|secondary rate/i.test(response.text)));
  if (limited) {
    const retry = headers["retry-after"];
    const reset = Number(headers["x-ratelimit-reset"]);
    const seconds = retry
      ? /^\d+$/.test(retry)
        ? Number(retry)
        : (Date.parse(retry) - Date.now()) / 1000
      : reset
        ? reset - Date.now() / 1000
        : 60;
    throw new ReachChannelError(
      "RATE_LIMITED",
      `${provider} 请求受限（HTTP ${status}）`,
      "等待冷却结束后再试",
      Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60,
    );
  }
  if (status === 404) throw new ReachChannelError("NOT_FOUND", `${provider} 返回 404`);
  if (status === 401)
    throw new ReachChannelError("NEED_SETUP", `${provider} 凭据无效`, "请在设置中检查账号配置");
  if (status === 403 || status === 451)
    throw new ReachChannelError("PLATFORM_BLOCKED", `${provider} 拒绝访问（HTTP ${status}）`);
  if (status >= 400) throw new ReachChannelError("UPSTREAM_BROKEN", `${provider} HTTP ${status}`);
}
