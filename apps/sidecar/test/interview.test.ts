import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import type { ModelResolver } from "@agentdesk/agent-core";
import { AppError, httpStatusOf } from "@agentdesk/shared";
import { Document, Packer, Paragraph } from "docx";
import { ZodError } from "zod";
import { openDatabase, type DbHandle } from "../src/db/client";
import { Collection } from "../src/db/collection";
import { SecretStore } from "../src/secrets";
import { InterviewService } from "../src/services/interview";
import {
  interviewChunks,
  interviewDate,
  parseInterviewText,
} from "../src/services/interview-parser";
import { FEISHU_ID, FEISHU_SECRET, InterviewSourceReader } from "../src/services/interview-sources";
import { interviewRoutes } from "../src/http/routes/interview";
import type { fetchPublicSource } from "../src/services/public-fetch";

let handle: DbHandle;
let secrets: SecretStore;
let service: InterviewService;
let faux: FauxProviderRegistration | undefined;
let models: ModelResolver;
beforeEach(() => {
  handle = openDatabase(":memory:");
  secrets = new SecretStore(handle.db, randomBytes(32).toString("base64"), ".");
  models = { resolve: vi.fn(async () => []) };
  service = new InterviewService(handle.db, models, secrets);
});
afterEach(async () => {
  vi.useRealTimers();
  await service.dispose();
  handle.close();
  faux?.unregister();
  faux = undefined;
});
const qa =
  "Q: 什么是闭包？\n答案：函数及其词法环境。\n\nQ: 什么是缓存？\n答案：复用之前的计算结果。";
async function seed(text = qa) {
  const [source] = service.import([{ kind: "text", name: "面试题", text }]);
  await service.idle();
  return source!;
}
function enableModel(answer: string) {
  faux = registerFauxProvider({ tokensPerSecond: 100_000 });
  models.resolve = async () => [
    { providerId: "faux", providerName: "faux", model: faux!.getModel(), apiKey: "test" },
  ];
  faux.setResponses([fauxAssistantMessage(fauxText(answer))]);
}

describe("问答来源与导入", () => {
  it("保留原答案的代码和换行，忽略代码块中的伪题目", () => {
    const answer = "使用以下代码：\n```ts\nQ: fake\nconst x = 1;\n```\n不要改写这句话。";
    const parsed = parseInterviewText(
      `## 1. 什么是闭包？\n答案：${answer}\n\nQ2: 什么是缓存？\n答案：TODO`,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.answer).toBe(answer);
    expect(parsed[1]?.answer).toBe("");
    expect(
      parseInterviewText("Q: 什么是缓存？\n答案：示例：\n~~~text\nQ: 这不是题目\n~~~"),
    ).toHaveLength(1);
    const longText = "abcdefgh\n".repeat(2000);
    expect(interviewChunks(longText).join("")).toBe(longText);
  });
  it("结构化资料无需模型；相同批次与重试不会重复建题", async () => {
    const source = await seed();
    expect(service.listSources()[0]).toMatchObject({ status: "ready", questionCount: 2 });
    expect(service.listSources()[0]).not.toHaveProperty("input");
    expect(service.list({}).items.every((q) => q.answerOrigin === "source")).toBe(true);
    expect(models.resolve).not.toHaveBeenCalled();
    await seed();
    service.retry(source.id);
    await service.idle();
    expect(service.list({}).total).toBe(2);
    expect(service.listSources()).toHaveLength(1);
  });
  it("只补没有答案的题，已有答案保持原文", async () => {
    enableModel("闭包保留定义时的词法环境。可用于封装私有状态。");
    await seed("Q: 什么是缓存？\n答案：作者的精确答案，不可重写。\n\nQ: 什么是闭包？");
    const questions = service.list({}).items;
    expect(questions.find((q) => q.question.includes("缓存"))).toMatchObject({
      answer: "作者的精确答案，不可重写。",
      answerOrigin: "source",
    });
    expect(questions.find((q) => q.question.includes("闭包"))).toMatchObject({
      answerOrigin: "ai",
      answer: "闭包保留定义时的词法环境。可用于封装私有状态。",
    });
  });
  it("模型不可用时保留题目，配置模型后重试补齐", async () => {
    const source = await seed("Q: 如何理解事件循环？");
    expect(service.stats().pendingAnswers).toBe(1);
    expect(service.listSources()[0]?.status).toBe("partial");
    const q = service.list({}).items[0]!;
    expect(() =>
      service.review(q.id, {
        requestId: "pending-review",
        rating: "easy",
        timeZone: "Asia/Shanghai",
      }),
    ).toThrow("补齐");
    enableModel("事件循环协调任务执行。每轮按运行环境处理任务与微任务。");
    service.retry(source.id);
    await service.idle();
    expect(service.stats()).toMatchObject({ total: 1, pendingAnswers: 0, aiAnswers: 1 });
    expect(service.listSources()[0]?.status).toBe("ready");
  });
  it("非结构化资料的 AI 提取需核实原文引用", async () => {
    enableModel(
      JSON.stringify({
        questions: [{ question: "解释缓存", questionQuote: "完全不存在的原文", answerQuote: "" }],
      }),
    );
    await seed("这份资料介绍缓存的原理，缓存能够复用之前计算的结果。");
    expect(service.list({}).total).toBe(0);
    expect(service.listSources()[0]?.error).toContain("引文无法");
  });
  it("在线资料后来补上的原答案替换 AI 答案，并保留练习和收藏", async () => {
    enableModel("AI 生成的缓存答案。");
    let text = "Q: 什么是缓存？";
    const reader = new InterviewSourceReader(secrets);
    vi.spyOn(reader, "read").mockImplementation(async () => ({
      documents: [{ name: "在线面试题", origin: "https://example.com/interview", text }],
      warnings: [],
    }));
    await service.dispose();
    service = new InterviewService(handle.db, models, secrets, reader);
    const [source] = service.import([{ kind: "url", url: "https://example.com/interview" }]);
    await service.idle();
    const question = service.list({}).items[0]!;
    expect(question.answerOrigin).toBe("ai");
    service.favorite(question.id, true);
    service.review(question.id, {
      requestId: "source-answer-review",
      rating: "easy",
      timeZone: "Asia/Shanghai",
    });
    text += "\n答案：作者补充的精确答案。\n第二段说明。";
    service.retry(source!.id);
    await service.idle();
    expect(service.list({}).items).toHaveLength(1);
    expect(service.list({}).items[0]).toMatchObject({
      id: question.id,
      answer: "作者补充的精确答案。\n第二段说明。",
      answerOrigin: "source",
      favorite: true,
      mastery: "mastered",
      reviews: 1,
      sourceExcerpt: text,
    });
  });
  it("重启会标记中断任务，重试保留原有练习和收藏", async () => {
    const source = await seed();
    const q = service.list({}).items[0]!;
    service.favorite(q.id, true);
    service.review(q.id, {
      requestId: "persist-review",
      rating: "easy",
      timeZone: "Asia/Shanghai",
    });
    const sources = new Collection<Record<string, unknown> & { id: string }>(
      handle.db,
      "interview-sources",
    );
    sources.put({ ...sources.get(source.id)!, status: "processing" });
    await service.dispose();
    service = new InterviewService(handle.db, models, secrets);
    expect(service.listSources()[0]?.status).toBe("error");
    service.retry(source.id);
    await service.idle();
    expect(service.list({ filter: "favorite" }).items[0]).toMatchObject({
      id: q.id,
      favorite: true,
      mastery: "mastered",
      reviews: 1,
    });
  });
});

describe("统计与打卡", () => {
  it("请求幂等，同题重复练习不重复计入每日目标", async () => {
    await seed();
    service.saveSettings({ dailyGoal: 2 });
    const [first, second] = service.list({}).items;
    const input = {
      requestId: "review-unique",
      rating: "easy" as const,
      timeZone: "Asia/Shanghai",
    };
    service.review(first!.id, input);
    service.review(first!.id, input);
    expect(service.list({ filter: "mastered" }).items[0]?.reviews).toBe(1);
    expect(() => service.review(second!.id, input)).toThrow();
    service.review(first!.id, { ...input, requestId: "review-another", rating: "again" });
    expect(service.stats().todayReviewed).toBe(1);
    expect(() => service.checkin()).toThrow("完成目标");
    service.review(second!.id, { ...input, requestId: "review-second" });
    expect(service.checkin()).toMatchObject({ todayReviewed: 2, checkedIn: true, streak: 1 });
    expect(service.checkin().streak).toBe(1);
    expect(() => service.saveSettings({ timeZone: "UTC" })).toThrow("时区");
  });
  it("按所选时区跨日统计，断签重置连续天数", async () => {
    await seed();
    service.saveSettings({ dailyGoal: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T15:59:00Z"));
    const q = service.list({}).items[0]!;
    const review = (id: string) =>
      service.review(q.id, { requestId: id, rating: "good", timeZone: "Asia/Shanghai" });
    review("review-day-one");
    expect(service.checkin()).toMatchObject({ date: "2026-11-09", streak: 1 });
    vi.setSystemTime(new Date("2026-11-09T16:01:00Z"));
    expect(service.stats()).toMatchObject({
      date: "2026-11-10",
      todayReviewed: 0,
      checkedIn: false,
      streak: 1,
    });
    review("review-day-two");
    expect(service.checkin().streak).toBe(2);
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    expect(service.stats().streak).toBe(0);
    expect(interviewDate("UTC", new Date("2026-11-09T16:01:00Z"))).toBe("2026-11-09");
  });
});

describe("文件和飞书", () => {
  it("DOCX 和 JSON 文件提取原有问答", async () => {
    const reader = new InterviewSourceReader(secrets);
    const docx = await Packer.toBuffer(
      new Document({
        sections: [
          { children: [new Paragraph("Q: 什么是闭包？"), new Paragraph("答案：函数和词法环境。")] },
        ],
      }),
    );
    const result = await reader.read(
      { kind: "file", name: "题库.docx", base64: docx.toString("base64") },
      new AbortController().signal,
    );
    expect(parseInterviewText(result.documents[0]!.text)[0]?.answer).toBe("函数和词法环境。");
    const json = await reader.read(
      {
        kind: "file",
        name: "题库.json",
        base64: Buffer.from(
          JSON.stringify([{ question: "如何理解缓存？", answer: "保留结果" }]),
        ).toString("base64"),
      },
      new AbortController().signal,
    );
    expect(parseInterviewText(json.documents[0]!.text)[0]?.answer).toBe("保留结果");
  }, 20_000);
  it("PDF 文件读取文字，释放文档", async () => {
    const content =
      "BT /F1 12 Tf 50 750 Td (Q: What is a cache?) Tj 0 -20 Td (Answer: Stored results.) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    objects.forEach((obj, i) => {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const start = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    const result = await new InterviewSourceReader(secrets).read(
      { kind: "file", name: "题库.pdf", base64: Buffer.from(pdf).toString("base64") },
      new AbortController().signal,
    );
    expect(result.documents[0]?.text).toContain("Stored results.");
    expect(parseInterviewText(result.documents[0]!.text)[0]).toMatchObject({
      question: "What is a cache?",
      answer: "Stored results.",
    });
  });
  it("受限飞书文件夹在无凭据时明确报错，不假装导入成功", async () => {
    const fetch = vi.fn<typeof fetchPublicSource>();
    await expect(
      new InterviewSourceReader(secrets, fetch).read(
        { kind: "url", url: "https://team.feishu.cn/drive/folder/folder1" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("需要授权");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("飞书遍历分页与子文件夹，逐项报告无权限和不支持类型", async () => {
    secrets.set(FEISHU_ID, "cli_test");
    secrets.set(FEISHU_SECRET, "private-secret");
    const fetch = vi.fn<typeof fetchPublicSource>(async (input, options) => {
      expect(new URL(input).hostname).toBe("open.feishu.cn");
      let data: unknown;
      if (input.includes("tenant_access_token"))
        return {
          status: 200,
          contentType: "application/json",
          headers: {},
          text: JSON.stringify({ code: 0, tenant_access_token: "tenant-test" }),
        };
      expect(options?.headers).toMatchObject({ Authorization: "Bearer tenant-test" });
      if (input.includes("folder_token=sub"))
        data = { files: [{ token: "doc2", name: "第二份", type: "docx" }] };
      else if (input.includes("page_token=next"))
        data = {
          files: [
            { token: "sheet", name: "表格", type: "sheet" },
            { token: "denied", name: "无权限", type: "docx" },
          ],
        };
      else if (input.includes("drive/v1/files"))
        data = {
          files: [
            { token: "doc1", name: "第一份", type: "docx" },
            { token: "sub", name: "子目录", type: "folder" },
          ],
          has_more: true,
          next_page_token: "next",
        };
      else data = { content: qa };
      return {
        status: 200,
        contentType: "application/json",
        headers: {},
        text: JSON.stringify({ code: input.includes("denied") ? 999 : 0, data }),
      };
    });
    const result = await new InterviewSourceReader(secrets, fetch).read(
      { kind: "url", url: "https://team.feishu.cn/drive/folder/root" },
      new AbortController().signal,
    );
    expect(result.documents).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(" ")).not.toContain("private-secret");
    expect(service.settings()).toMatchObject({ hasFeishuSecret: true, feishuAppId: "cli_test" });
    expect(JSON.stringify(service.settings())).not.toContain("private-secret");
  });
  it("拒绝私网链接和空文件", async () => {
    const reader = new InterviewSourceReader(secrets);
    await expect(
      reader.read({ kind: "url", url: "http://127.0.0.1/test" }, new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      reader.read({ kind: "file", name: "空.txt", base64: "IA==" }, new AbortController().signal),
    ).rejects.toThrow("未读取到正文");
  });
});

it("接口验证批次、筛选和设置，不返回原始文件或 Secret", async () => {
  const app = interviewRoutes({ interview: service });
  app.onError((error, c) =>
    c.json(
      { message: error.message },
      error instanceof ZodError
        ? 400
        : error instanceof AppError
          ? (httpStatusOf(error.code) as 400)
          : 500,
    ),
  );
  const post = (path: string, body: unknown, method = "POST") =>
    app.request(`/learning/interview/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await post("imports", { items: [] })).status).toBe(400);
  expect((await post("settings", { dailyGoal: 0 }, "PUT")).status).toBe(400);
  expect((await app.request("/learning/interview/questions?filter=unknown")).status).toBe(400);
  const response = await post("imports", { items: [{ kind: "text", name: "test", text: qa }] });
  expect(response.status).toBe(202);
  expect(JSON.stringify(await response.json())).not.toContain("词法环境");
  await service.idle();
  expect((await app.request("/learning/interview/stats")).status).toBe(200);
});
