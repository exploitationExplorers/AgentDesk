import { Octokit } from "@octokit/rest";
import type { RemoteActivity } from "@agentdesk/shared";

export interface RemoteAdapter {
  listActivity(owner: string, repo: string): Promise<RemoteActivity[]>;
}

export class GitHubAdapter implements RemoteAdapter {
  private readonly client: Octokit;
  constructor(token?: string) {
    this.client = new Octokit({ auth: token, userAgent: "AgentDesk" });
  }

  async listActivity(owner: string, repo: string): Promise<RemoteActivity[]> {
    const [pulls, issues] = await Promise.all([
      this.client.pulls.list({ owner, repo, state: "open", per_page: 20 }),
      this.client.issues.listForRepo({ owner, repo, state: "open", per_page: 20 }),
    ]);
    return [
      ...pulls.data.map((p) => ({
        kind: "pull_request" as const,
        number: p.number,
        title: p.title,
        state: p.draft ? "draft" : p.state,
        url: p.html_url,
        author: p.user?.login ?? "",
        updatedAt: p.updated_at,
      })),
      ...issues.data
        .filter((i) => !i.pull_request)
        .map((i) => ({
          kind: "issue" as const,
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.html_url,
          author: i.user?.login ?? "",
          updatedAt: i.updated_at,
        })),
    ];
  }
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}: ${url.split("?")[0]}`);
  return (await response.json()) as T;
}

export class GiteeAdapter implements RemoteAdapter {
  constructor(private readonly token?: string) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const query = new URLSearchParams({
      ...params,
      ...(this.token ? { access_token: this.token } : {}),
    });
    return `https://gitee.com/api/v5${path}?${query}`;
  }

  async listActivity(owner: string, repo: string): Promise<RemoteActivity[]> {
    type GiteeItem = {
      number: number | string;
      title: string;
      state: string;
      html_url: string;
      user?: { login: string };
      updated_at: string;
    };
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const [pulls, issues] = await Promise.all([
      getJson<GiteeItem[]>(this.url(`${base}/pulls`, { state: "open", per_page: "20" })),
      getJson<GiteeItem[]>(this.url(`${base}/issues`, { state: "open", per_page: "20" })).catch(
        () => [],
      ),
    ]);
    const map =
      (kind: RemoteActivity["kind"]) =>
      (i: GiteeItem): RemoteActivity => ({
        kind,
        number: Number.parseInt(String(i.number).replace(/\D/g, ""), 10) || 0,
        title: i.title,
        state: i.state,
        url: i.html_url,
        author: i.user?.login ?? "",
        updatedAt: i.updated_at,
      });
    return [...pulls.map(map("pull_request")), ...issues.map(map("issue"))];
  }
}

export class GitLabAdapter implements RemoteAdapter {
  constructor(
    private readonly host: string,
    private readonly token?: string,
  ) {}

  async listActivity(owner: string, repo: string): Promise<RemoteActivity[]> {
    type GitLabItem = {
      iid: number;
      title: string;
      state: string;
      web_url: string;
      author?: { username: string };
      updated_at: string;
    };
    const project = encodeURIComponent(`${owner}/${repo}`);
    const base = `${this.host.startsWith("http") ? this.host : `https://${this.host}`}/api/v4/projects/${project}`;
    const headers = this.token ? { "PRIVATE-TOKEN": this.token } : undefined;
    const [mrs, issues] = await Promise.all([
      getJson<GitLabItem[]>(`${base}/merge_requests?state=opened&per_page=20`, headers),
      getJson<GitLabItem[]>(`${base}/issues?state=opened&per_page=20`, headers).catch(() => []),
    ]);
    const map =
      (kind: RemoteActivity["kind"]) =>
      (i: GitLabItem): RemoteActivity => ({
        kind,
        number: i.iid,
        title: i.title,
        state: i.state,
        url: i.web_url,
        author: i.author?.username ?? "",
        updatedAt: i.updated_at,
      });
    return [...mrs.map(map("merge_request")), ...issues.map(map("issue"))];
  }
}

export function createAdapter(
  platform: string,
  host: string,
  token?: string,
): RemoteAdapter | null {
  switch (platform) {
    case "github":
      return new GitHubAdapter(token);
    case "gitee":
      return new GiteeAdapter(token);
    case "gitlab":
      return new GitLabAdapter(host, token);
    default:
      return null;
  }
}
