import { Octokit } from "@octokit/rest";
import type { RemoteActivity } from "@agentdesk/shared";

export interface ListedRemoteRepo {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  updatedAt: string | null;
}

export interface RemoteAdapter {
  listActivity(owner: string, repo: string): Promise<RemoteActivity[]>;
  /** 列出当前 Token 可见的仓库（用于导入选择） */
  listRepos?(): Promise<ListedRemoteRepo[]>;
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

  async listRepos(): Promise<ListedRemoteRepo[]> {
    const repos = await this.client.paginate(this.client.repos.listForAuthenticatedUser, {
      per_page: 100,
      sort: "updated",
      affiliation: "owner,collaborator,organization_member",
    });
    return repos.map((r) => ({
      id: String(r.id),
      name: r.name,
      fullName: r.full_name,
      description: r.description,
      cloneUrl: r.clone_url,
      htmlUrl: r.html_url,
      private: r.private,
      updatedAt: r.updated_at,
    }));
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

  async listRepos(): Promise<ListedRemoteRepo[]> {
    type GiteeRepo = {
      id: number;
      name: string;
      full_name: string;
      description: string | null;
      html_url: string;
      private: boolean;
      updated_at: string;
      namespace?: { path: string };
    };
    const out: ListedRemoteRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await getJson<GiteeRepo[]>(
        this.url("/user/repos", {
          type: "all",
          sort: "updated",
          per_page: "100",
          page: String(page),
        }),
      );
      if (!batch.length) break;
      for (const r of batch) {
        out.push({
          id: String(r.id),
          name: r.name,
          fullName: r.full_name,
          description: r.description,
          cloneUrl: `https://gitee.com/${r.full_name}.git`,
          htmlUrl: r.html_url,
          private: r.private,
          updatedAt: r.updated_at,
        });
      }
      if (batch.length < 100) break;
    }
    return out;
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
