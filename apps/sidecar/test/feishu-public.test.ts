import { describe, expect, it, vi } from "vitest";
import {
  extractFeishuPublicDocument,
  FeishuGuestCookies,
  readFeishuPublicDocument,
} from "../src/services/feishu-public";
import { parseInterviewText } from "../src/services/interview-parser";
import { InterviewSourceReader } from "../src/services/interview-sources";
import type { fetchPublicSource } from "../src/services/public-fetch";

const url = new URL("https://team.feishu.cn/docx/testdoc?pre_pathname=%2Fdrive%2Ffolder%2Ftest");
function block(type: string, text: string, children: string[] = []) {
  return { data: { type, children, text: { initialAttributedTexts: { text: { "0": text } } } } };
}
function fixture(options: { partial?: boolean; missing?: boolean; code?: string } = {}) {
  const map = {
    doc: block("page", "模型面试题", [
      "q1",
      "a1",
      "list",
      "q2",
      "a2",
      ...(options.code ? ["code"] : []),
    ]),
    q1: block("heading2", "如何实现请求合并？"),
    a1: block("text", "作者原答案。"),
    list: block("ordered", "请求收集窗口", ["detail"]),
    ...(!options.missing ? { detail: block("bullet", "等待 10 ms，然后批量发送。") } : {}),
    q2: block("heading2", "请设计模型监控面板"),
    a2: block("text", "第二题原答案。"),
    ...(options.code ? { code: block("code", options.code) } : {}),
  };
  // 页面按钮含“登录”并不代表正文禁止访客读取；目录和首屏不能作为完整题库。
  return `<body>登录/注册<nav>假题目目录</nav><script>window.DATA = Object.assign({}, window.DATA, { clientVars: Object(${JSON.stringify({ code: 0, data: { id: "doc", has_more: options.partial ?? false, block_map: map } })}) });</script><main>首屏只有一部分</main></body>`;
}

describe("飞书公开正文", () => {
  it("读取有序完整数据，保留原答案，不把请求收集窗口拆为新题", () => {
    const document = extractFeishuPublicDocument(fixture())!;
    expect(document.name).toBe("模型面试题");
    const questions = parseInterviewText(document.text);
    expect(questions).toHaveLength(2);
    expect(questions[0]?.answer).toContain("作者原答案。");
    expect(questions[0]?.answer).toContain("请求收集窗口");
    expect(questions[0]?.answer).toContain("等待 10 ms，然后批量发送。");
    expect(questions[1]?.answer).toBe("第二题原答案。");
    expect(document.text).not.toMatch(/登录|假题目目录|首屏/);
  });
  it("保留代码中的伪题目及反引号", () => {
    const code = 'const text = "``` }) }";\nQ: 代码里的内容';
    const questions = parseInterviewText(extractFeishuPublicDocument(fixture({ code }))!.text);
    expect(questions).toHaveLength(2);
    expect(questions[1]?.answer).toContain(code);
  });
  it("正文分批加载或缺少子节点时不静默丢失答案", () => {
    expect(() => extractFeishuPublicDocument(fixture({ partial: true }))).toThrow("部分正文");
    expect(() => extractFeishuPublicDocument(fixture({ missing: true }))).toThrow("尚未加载");
  });
  it("只有登录页时不伪造文档", () => {
    expect(extractFeishuPublicDocument("<body>登录/注册</body>")).toBeNull();
  });
  it("公开文档无需 App Secret；带返回路径参数也能导入", async () => {
    const fetch = vi.fn<typeof fetchPublicSource>(async () => ({
      status: 200,
      contentType: "text/html",
      headers: {},
      text: fixture(),
    }));
    const reader = new InterviewSourceReader({ get: () => null }, fetch);
    const result = await reader.read({ kind: "url", url: url.href }, new AbortController().signal);
    expect(result.documents[0]?.name).toBe("模型面试题");
    expect(parseInterviewText(result.documents[0]!.text)).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(
      url.href,
      expect.objectContaining({ maxRedirects: 10, cookieJar: expect.any(FeishuGuestCookies) }),
    );
  });
  it("访客跳转不能离开飞书 HTTPS 域名", async () => {
    const fetch = vi.fn<typeof fetchPublicSource>(async (_url, options) => {
      options?.onRequest?.(new URL("https://feishu.cn.evil.example/path"));
      throw new Error("unreachable");
    });
    await expect(
      readFeishuPublicDocument(url, new AbortController().signal, fetch),
    ).rejects.toThrow("非飞书");
  });
});

describe("飞书公开正文分页", () => {
  function envelope(
    map: Record<string, ReturnType<typeof block>>,
    next: string[] = [],
    extra: Record<string, unknown> = {},
  ) {
    return {
      code: 0,
      data: {
        id: "doc",
        structure_version: 3,
        has_more: next.length > 0,
        next_cursors: next,
        block_map: map,
        ...extra,
      },
    };
  }
  const first = () =>
    envelope(
      {
        doc: block("page", "分页面试题", ["q1", "a1", "q2", "a2", "q3", "a3"]),
        q1: block("heading2", "如何理解流式输出？"),
        a1: block("text", "第一题原答案。"),
      },
      ["page-2"],
    );
  const second = () =>
    envelope(
      {
        q2: block("heading2", "设计一个流式数据缓存策略"),
        a2: block("text", "第二题的原答案在第二批。"),
      },
      ["page-3"],
    );
  const third = () =>
    envelope({
      q3: block("heading2", "设计一种多模型流式对比方案"),
      a3: block("code", "const streams = new Map();\n// 最后一题的代码答案"),
    });
  function mockPages(pages: unknown[], initial = first()) {
    const fetch = vi.fn<typeof fetchPublicSource>();
    fetch.mockResolvedValueOnce({
      status: 200,
      contentType: "text/html",
      headers: {},
      text: `<script>window.DATA = { clientVars: Object(${JSON.stringify(initial)}) };</script>`,
    });
    for (const value of pages)
      fetch.mockResolvedValueOnce({
        status: 200,
        contentType: "application/json",
        headers: {},
        text: JSON.stringify(value),
      });
    return fetch;
  }

  it("复用访客会话取完多批正文，按原顺序保留末题与代码答案", async () => {
    const fetch = mockPages([second(), third()]);
    const document = await readFeishuPublicDocument(url, new AbortController().signal, fetch);
    const questions = parseInterviewText(document!.text);
    expect(questions).toHaveLength(3);
    expect(questions[1]?.answer).toBe("第二题的原答案在第二批。");
    expect(questions[2]?.answer).toContain("// 最后一题的代码答案");
    expect(questions.map((q) => q.question)).toEqual([
      "如何理解流式输出？",
      "设计一个流式数据缓存策略",
      "设计一种多模型流式对比方案",
    ]);
    const [, secondCall, thirdCall] = fetch.mock.calls;
    expect(new URL(secondCall![0]).pathname).toBe("/space/api/docx/pages/client_vars");
    expect(new URL(secondCall![0]).searchParams.get("cursor")).toBe("page-2");
    expect(new URL(thirdCall![0]).searchParams.get("cursor")).toBe("page-3");
    expect(secondCall![1]?.cookieJar).toBe(fetch.mock.calls[0]![1]?.cookieJar);
    expect(thirdCall![1]?.cookieJar).toBe(secondCall![1]?.cookieJar);
  });

  it("同一批列出多个游标时读完全部分支", async () => {
    const initial = first();
    initial.data.next_cursors = ["page-2", "page-3"];
    const fetch = mockPages([envelope(second().data.block_map), third()], initial);
    const document = await readFeishuPublicDocument(url, new AbortController().signal, fetch);
    expect(parseInterviewText(document!.text)).toHaveLength(3);
  });

  it.each([
    ["重复游标", () => envelope(second().data.block_map, ["page-2"]), "游标重复"],
    ["缺失游标", () => envelope(second().data.block_map, [], { has_more: true }), "缺少下一批"],
    ["文档错配", () => envelope(second().data.block_map, [], { id: "another-doc" }), "发生变化"],
    ["版本变化", () => envelope(second().data.block_map, [], { structure_version: 4 }), "发生变化"],
    ["缺少子节点", () => envelope(second().data.block_map), "尚未加载"],
    [
      "省略内容",
      () => envelope(second().data.block_map, [], { skip_blocks: ["missing"] }),
      "未提供",
    ],
    ["后续无权限", () => ({ code: 403, data: {} }), "没有阅读权限"],
  ] as const)("%s 时不返回不完整题库", async (_name, page, error) => {
    await expect(
      readFeishuPublicDocument(url, new AbortController().signal, mockPages([page()])),
    ).rejects.toThrow(error);
  });

  it("分页只访问文档同一来源，停止时不再读取下一批", async () => {
    const controller = new AbortController();
    const fetch = mockPages([]);
    fetch.mockImplementationOnce(async (_input, options) => {
      expect(() => options!.onRequest!(new URL("https://another.feishu.cn/path"))).toThrow(
        "其他来源",
      );
      controller.abort();
      return {
        status: 200,
        contentType: "application/json",
        headers: {},
        text: JSON.stringify(second()),
      };
    });
    await expect(readFeishuPublicDocument(url, controller.signal, fetch)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("临时飞书访客 Cookie", () => {
  it("只向匹配域名和路径发送，不泄露到外部来源", () => {
    const jar = new FeishuGuestCookies();
    jar.set(new URL("https://accounts.feishu.cn/login"), [
      "guest=abc; Domain=.feishu.cn; Path=/; Secure; HttpOnly",
      "local=only; Path=/accounts; Secure",
      "invalid=bad; Domain=.cn; Path=/",
      "foreign=bad; Domain=example.com; Path=/",
    ]);
    expect(jar.get(url)).toBe("guest=abc");
    expect(jar.get(new URL("https://accounts.feishu.cn/accounts/start"))).toBe(
      "local=only; guest=abc",
    );
    expect(jar.get(new URL("https://accounts.feishu.cn/accounts-other"))).toBe("guest=abc");
    expect(jar.get(new URL("https://feishu.cn.evil.example/"))).toBe("");
    expect(jar.get(new URL("http://team.feishu.cn/"))).toBe("");
    expect(new FeishuGuestCookies().get(url)).toBe("");
  });
  it("尊重过期和删除指令", () => {
    const jar = new FeishuGuestCookies();
    jar.set(url, [
      "session=guest; Path=/",
      "old=expired; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ]);
    expect(jar.get(url)).toBe("session=guest");
    jar.set(url, ["session=; Path=/; Max-Age=0"]);
    expect(jar.get(url)).toBe("");
  });
});
