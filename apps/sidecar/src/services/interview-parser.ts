import { createHash } from "node:crypto";

export interface ExtractedInterviewQuestion {
  question: string;
  answer: string;
  excerpt: string;
}
export const interviewHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** 结构明确的问答直接保留原文，不让模型重写作者的答案。 */
export function parseInterviewText(text: string): ExtractedInterviewQuestion[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const starts: Array<{ index: number; question: string }> = [];
  let fence = "";
  lines.forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      return;
    }
    if (fence) return;
    const clean = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\*(.*?)\*\*$/, "$1");
    const explicit = /^(?:Q\s*\d*|问题\s*\d*|问|题目\s*\d*)\s*[:：.、]\s*(.+)$/i.exec(clean);
    const numbered = /^(?:\d+[.)、．]|[（(]\d+[)）])\s*(.+)$/.exec(clean);
    const body = explicit?.[1] ?? numbered?.[1] ?? clean;
    const looksLikeQuestion =
      /[?？]$|^(?:什么|如何|为什么|怎么|请(?!求)|设计(?:一个|一套|一种)|解释|介绍|简述|谈谈|描述|说说)|(?:区别|原理|机制|过程|特点|优缺点|是什么)$/.test(
        body,
      );
    if (explicit || ((numbered || /^\s*#{1,6}\s/.test(line)) && looksLikeQuestion)) {
      starts.push({ index, question: body.trim() });
    }
  });
  return starts.map((entry, index) => {
    const end = starts[index + 1]?.index ?? lines.length;
    const body = lines
      .slice(entry.index + 1, end)
      .join("\n")
      .trim();
    const answer = body
      .replace(/^(?:\*\*)?(?:参考答案|标准答案|答案|答|Answer|A)(?:\*\*)?\s*[:：]\s*/i, "")
      .trim();
    const missing = /^(?:暂无(?:答案)?|待补充|略|TODO|待回答|无答案)[。.]?$/i.test(answer);
    return {
      question: entry.question,
      answer: missing ? "" : answer,
      excerpt: lines.slice(entry.index, end).join("\n"),
    };
  });
}

export function interviewChunks(text: string): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 8000) {
    const boundary = rest.lastIndexOf("\n", 8000);
    const cut = boundary > 4000 ? boundary : 8000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

export function interviewCategory(question: string): string {
  const rules: Array<[RegExp, string]> = [
    [/react|vue|css|html|浏览器|前端|javascript|typescript|闭包|原型|事件循环/i, "前端开发"],
    [/sql|mysql|redis|数据库|索引|事务|缓存/i, "数据库"],
    [/java|spring|jvm|golang|后端|微服务/i, "后端开发"],
    [/tcp|http|网络|dns|https|socket/i, "计算机网络"],
    [/算法|排序|复杂度|链表|二叉树|队列|栈|动态规划/i, "算法与数据结构"],
    [/项目|经历|团队|职业|离职|自我介绍/i, "项目与沟通"],
  ];
  return rules.find(([pattern]) => pattern.test(question))?.[1] ?? "综合知识";
}

export function interviewDate(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function shiftInterviewDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
