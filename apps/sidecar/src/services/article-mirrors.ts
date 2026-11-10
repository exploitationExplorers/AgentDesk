/**
 * 部分公开文档站（如 Hello 算法）部署在带人机校验的 CDN 上，
 * 直接抓取会返回 429 / challenge，但正文本身在 GitHub 上开源。
 * 这里把已知站点映射到可公开读取的源码镜像，避免把用户链接交给第三方中转。
 */

export interface ArticleMirror {
  hosts: string[];
  /** 按优先顺序返回候选镜像 URL（通常是 raw.githubusercontent.com）。 */
  resolve(url: URL): string[];
  /** 文档站目录（MkDocs nav），用来还原章节，而不是把整本书写进代码。 */
  catalog?: string;
  siteOrigin: string;
}

const HELLO_ALGO_RAW = "https://raw.githubusercontent.com/krahets/hello-algo/main/docs";

const helloAlgo: ArticleMirror = {
  hosts: ["hello-algo.com", "www.hello-algo.com"],
  catalog: "https://raw.githubusercontent.com/krahets/hello-algo/main/mkdocs.yml",
  siteOrigin: "https://www.hello-algo.com",
  resolve(url) {
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "/") return [`${HELLO_ALGO_RAW}/index.md`];
    // MkDocs 既有 `foo.md` 也有 `foo/index.md`，按常见顺序各试一次。
    return [`${HELLO_ALGO_RAW}${path}.md`, `${HELLO_ALGO_RAW}${path}/index.md`];
  },
};

const MIRRORS: ArticleMirror[] = [helloAlgo];

export function articleMirrorCandidates(input: string): string[] {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return [];
  }
  const host = url.hostname.toLowerCase();
  return MIRRORS.filter((mirror) => mirror.hosts.includes(host)).flatMap((mirror) =>
    mirror.resolve(url),
  );
}

/** 已知有稳定公开镜像的站点，优先走镜像，避免无谓撞 CDN 校验。 */
export function prefersArticleMirror(input: string): boolean {
  return articleMirrorCandidates(input).length > 0;
}

export function articleCatalog(input: string): { catalog: string; siteOrigin: string } | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const mirror = MIRRORS.find((item) => item.hosts.includes(host) && item.catalog);
  if (!mirror?.catalog) return null;
  return { catalog: mirror.catalog, siteOrigin: mirror.siteOrigin };
}
