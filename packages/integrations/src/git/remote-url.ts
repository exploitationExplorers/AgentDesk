import type { GitPlatform } from "@agentdesk/shared";

export interface ParsedRemote {
  platform: GitPlatform;
  host: string;
  owner: string;
  repo: string;
  webUrl: string;
}

/**
 * 解析 https / ssh / scp 风格的 remote 地址。
 * GitLab 常为公司自建域名，因此允许传入额外的 GitLab 主机列表。
 */
export function parseRemote(url: string, gitlabHosts: string[] = []): ParsedRemote | null {
  const trimmed = url.trim();
  let host: string;
  let path: string;

  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (/^[a-z+]+:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      host = u.port && !trimmed.startsWith("ssh") ? `${u.hostname}:${u.port}` : u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else if (scp?.[1] && scp[2]) {
    host = scp[1];
    path = scp[2];
  } else {
    return null;
  }

  const segments = path
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments.pop()!;
  const owner = segments.join("/");
  const bareHost = host.split(":")[0]!.toLowerCase();
  const fullHost = host.toLowerCase();
  const knownGitlab = gitlabHosts.some((h) => {
    const cfg = h
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    const cfgBare = cfg.split(":")[0]!;
    return cfg === fullHost || cfgBare === bareHost || cfg === bareHost;
  });

  let platform: GitPlatform = "unknown";
  if (bareHost === "github.com") platform = "github";
  else if (bareHost === "gitee.com") platform = "gitee";
  else if (bareHost.includes("gitlab") || knownGitlab) platform = "gitlab";

  const webHost = trimmed.startsWith("http") ? host : bareHost;
  const scheme = trimmed.startsWith("http://") ? "http" : "https";
  return {
    platform,
    host: webHost,
    owner,
    repo,
    webUrl: `${scheme}://${webHost}/${owner}/${repo}`,
  };
}
