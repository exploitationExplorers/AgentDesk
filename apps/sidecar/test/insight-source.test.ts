import { expect, it, vi } from "vitest";
import { articleMirrorCandidates } from "../src/services/article-mirrors";
import { articleText, readPublicArticle } from "../src/services/insight-source";

vi.mock("../src/services/public-fetch", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchPublicSource: vi.fn(),
  };
});

import { fetchPublicSource } from "../src/services/public-fetch";

it("把 Hello 算法文档页映射到 GitHub raw 候选", () => {
  expect(articleMirrorCandidates("https://www.hello-algo.com/chapter_hello_algo/")).toEqual([
    "https://raw.githubusercontent.com/krahets/hello-algo/main/docs/chapter_hello_algo.md",
    "https://raw.githubusercontent.com/krahets/hello-algo/main/docs/chapter_hello_algo/index.md",
  ]);
  expect(
    articleMirrorCandidates(
      "https://hello-algo.com/chapter_computational_complexity/time_complexity/",
    ),
  ).toEqual([
    "https://raw.githubusercontent.com/krahets/hello-algo/main/docs/chapter_computational_complexity/time_complexity.md",
    "https://raw.githubusercontent.com/krahets/hello-algo/main/docs/chapter_computational_complexity/time_complexity/index.md",
  ]);
});

it("抽取 Markdown 时去掉 front matter", () => {
  const text = articleText(
    `---\ncomments: true\n---\n\n# 序\n\n${"算法入门内容。".repeat(20)}`,
    "text/plain",
  );
  expect(text.startsWith("# 序")).toBe(true);
  expect(text).not.toContain("comments:");
});

it("Hello 算法只走 raw 镜像，不回落到会被 CDN 校验拦下的源站", async () => {
  const body = `# 序\n\n${"这是 Hello 算法正文，用于验证导入链路。".repeat(8)}`;
  vi.mocked(fetchPublicSource).mockImplementation(async (url) => {
    if (url.includes("raw.githubusercontent.com") && url.endsWith("/index.md")) {
      return {
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: {},
        text: body,
      };
    }
    if (url.includes("raw.githubusercontent.com")) {
      return { status: 404, contentType: "text/plain", headers: {}, text: "Not Found" };
    }
    throw new Error("不应请求源站");
  });

  const text = await readPublicArticle("https://www.hello-algo.com/chapter_hello_algo/");
  expect(text).toContain("Hello 算法正文");
  expect(vi.mocked(fetchPublicSource).mock.calls.map(([url]) => url)).toEqual([
    "https://raw.githubusercontent.com/krahets/hello-algo/main/docs/chapter_hello_algo.md",
    "https://raw.githubusercontent.com/krahets/hello-algo/main/docs/chapter_hello_algo/index.md",
  ]);
});
