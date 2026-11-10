import { expect, it } from "vitest";
import { parseArticle, parseMkdocsNav } from "../src/services/docs-article";

const nav = `
nav:
  - 序:
    - chapter_hello_algo/index.md
  - 第 2 章 &nbsp; 复杂度分析:
    - 2.3 &nbsp; 时间复杂度: chapter_computational_complexity/time_complexity.md
theme:
  name: material
`;

it("从 MkDocs 目录还原章节链接，不把后面的配置吃进来", () => {
  const chapters = parseMkdocsNav(nav, "https://www.hello-algo.com");
  expect(chapters.map((item) => item.title)).toEqual(["序", "第 2 章 复杂度分析"]);
  expect(chapters[0]).toMatchObject({
    title: "序",
    url: "https://www.hello-algo.com/chapter_hello_algo/",
    children: [],
  });
  expect(chapters[1]?.children[0]).toMatchObject({
    title: "2.3 时间复杂度",
    url: "https://www.hello-algo.com/chapter_computational_complexity/time_complexity/",
  });
});

it("把同一组多语言示例收成一张代码卡片", () => {
  const tick = "`".repeat(3);
  const blocks = parseArticle(
    [
      "# 时间复杂度",
      "",
      "运行时间可以反映算法效率。",
      "",
      '=== "Python"',
      "",
      `    ${tick}python title=""`,
      "    def algorithm(n: int):",
      "        a = 2",
      `    ${tick}`,
      "",
      '=== "C++"',
      "",
      `    ${tick}cpp title=""`,
      "    void algorithm(int n) {",
      "        int a = 2;",
      "    }",
      `    ${tick}`,
    ].join("\n"),
  );
  expect(blocks.map((block) => block.kind)).toEqual(["prose", "code"]);
  const code = blocks[1];
  expect(code?.kind).toBe("code");
  if (code?.kind !== "code") return;
  expect(code.tabs.map((tab) => tab.label)).toEqual(["Python", "C++"]);
  expect(code.tabs[0]?.code).toContain("def algorithm");
  expect(code.tabs[0]?.code.startsWith(" ")).toBe(false);
});
