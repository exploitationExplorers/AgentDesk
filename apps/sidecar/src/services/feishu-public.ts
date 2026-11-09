import { getSetCookies, Headers } from "undici";
import { z } from "zod";
import { AppError, ErrorCode } from "@agentdesk/shared";
import { fetchPublicSource } from "./public-fetch";

/** 只保存本次公开阅读产生的访客 Cookie，不读取用户浏览器或持久化登录态。 */
export class FeishuGuestCookies {
  private readonly cookies = new Map<
    string,
    {
      name: string;
      value: string;
      domain: string;
      path: string;
      hostOnly: boolean;
      expires: number;
    }
  >();

  get(url: URL): string {
    if (url.protocol !== "https:" || !isFeishuHost(url.hostname)) return "";
    return [...this.cookies.values()]
      .filter(
        (cookie) =>
          cookie.expires > Date.now() &&
          (url.hostname === cookie.domain ||
            (!cookie.hostOnly && url.hostname.endsWith(`.${cookie.domain}`))) &&
          (url.pathname === cookie.path ||
            url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)),
      )
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  set(url: URL, values: string[]): void {
    if (url.protocol !== "https:" || !isFeishuHost(url.hostname)) return;
    const headers = new Headers();
    values.forEach((value) => headers.append("set-cookie", value));
    for (const cookie of getSetCookies(headers)) {
      const domain = (cookie.domain ?? url.hostname).replace(/^\./, "").toLowerCase();
      if (
        !isFeishuHost(domain) ||
        !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      )
        continue;
      const path = cookie.path?.startsWith("/")
        ? cookie.path
        : url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
      const expires =
        cookie.maxAge !== undefined
          ? Date.now() + cookie.maxAge * 1000
          : cookie.expires
            ? Number(new Date(cookie.expires))
            : Infinity;
      const key = `${domain}\0${path}\0${cookie.name}`;
      if (expires <= Date.now()) this.cookies.delete(key);
      else if (this.cookies.size < 100 || this.cookies.has(key))
        this.cookies.set(key, {
          name: cookie.name,
          value: cookie.value,
          domain,
          path,
          expires,
          hostOnly: !cookie.domain,
        });
    }
  }
}

const isFeishuHost = (hostname: string) => /(?:^|\.)feishu\.cn$/.test(hostname);
const bad = (message: string) => new AppError(ErrorCode.BadRequest, message);
const blockSchema = z.object({
  data: z.object({
    type: z.string(),
    children: z.array(z.string()).default([]),
    hidden: z.boolean().optional(),
    text: z
      .object({
        initialAttributedTexts: z.object({ text: z.record(z.string(), z.string()) }),
      })
      .optional(),
  }),
});
const clientVarsSchema = z.object({
  code: z.number(),
  data: z.object({
    id: z.string(),
    has_more: z.boolean(),
    block_map: z.record(z.string(), blockSchema),
    skip_blocks: z.array(z.unknown()).optional(),
    next_cursors: z.array(z.string().min(1).max(8192)).optional(),
    structure_version: z.number().optional(),
  }),
});

/** 只 JSON.parse 服务端嵌入的数据，不执行网页脚本。 */
function embeddedClientVars(html: string): z.infer<typeof clientVarsSchema>["data"] | null {
  const match = /clientVars:\s*Object\(\s*(?=\{)/.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  // 答案中的代码可能包含 }) }，不能用非贪婪正则截取整个 JSON。
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) throw bad("飞书公开文档数据不完整，请重试或导出文件后导入");
  let value: unknown;
  try {
    value = JSON.parse(html.slice(start, end));
  } catch {
    throw bad("飞书公开文档数据格式已变化，请导出文件后导入");
  }
  const parsed = clientVarsSchema.safeParse(value);
  if (!parsed.success || parsed.data.code !== 0)
    throw bad("飞书公开文档数据格式已变化或没有阅读权限，请导出文件后导入");
  return parsed.data.data;
}

/** 同步提取只接受完整正文；在线读取会先合并分页，再走同一个渲染器。 */
export function extractFeishuPublicDocument(html: string): { name: string; text: string } | null {
  const data = embeddedClientVars(html);
  return data ? renderDocument(data) : null;
}

function renderDocument(data: z.infer<typeof clientVarsSchema>["data"]) {
  if (data.has_more || data.skip_blocks?.length || data.next_cursors?.length)
    throw bad("飞书页面只提供部分正文，请使用飞书应用授权或导出文件，避免遗漏题目与答案");
  const root = data.block_map[data.id];
  if (!root || root.data.type !== "page") throw bad("飞书文档缺少正文根节点");
  const textOf = (block: z.infer<typeof blockSchema>) =>
    Object.entries(block.data.text?.initialAttributedTexts.text ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, value]) => value)
      .join("\n");
  const lines: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (visited.has(id) || depth > 40 || visited.size >= 5000)
      throw bad("飞书文档结构异常或过大，请拆分后导入");
    visited.add(id);
    const block = data.block_map[id];
    if (!block) throw bad("飞书正文存在尚未加载的内容，请授权应用或导出文件后导入");
    if (block.data.hidden) return;
    const text = textOf(block);
    const type = block.data.type;
    if (type !== "page" && text) {
      if (/^heading[1-6]$/.test(type))
        lines.push(`${"#".repeat(Number(type.at(-1)))} ${text.trim()}`);
      else if (type === "code") {
        const length = Math.max(3, ...(text.match(/`+/g) ?? []).map((s) => s.length + 1));
        const fence = "`".repeat(length);
        lines.push(`${fence}\n${text}\n${fence}`);
      } else if (type === "bullet" || type === "ordered")
        lines.push(
          `${"  ".repeat(Math.max(0, depth - 1))}${type === "bullet" ? "-" : "1."} ${text}`,
        );
      else lines.push(text);
    } else if (
      !["page", "text", "divider", "grid", "grid_column", "quote_container"].includes(type) &&
      !text &&
      !block.data.children.length
    ) {
      throw bad(`飞书正文含无法提取的 ${type} 内容，请导出文件后导入，避免将原答案误判为缺失`);
    }
    block.data.children.forEach((child) => visit(child, depth + 1));
  };
  visit(data.id, 0);
  return { name: textOf(root).trim() || "飞书面试资料", text: lines.join("\n\n") };
}

export async function readFeishuPublicDocument(
  url: URL,
  signal: AbortSignal,
  fetchSource = fetchPublicSource,
): Promise<{ name: string; text: string } | null> {
  const cookieJar = new FeishuGuestCookies();
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const response = await fetchSource(url.href, {
    signal: readSignal,
    maxRedirects: 10,
    cookieJar,
    headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9" },
    onRequest: (target) => {
      if (target.protocol !== "https:" || !isFeishuHost(target.hostname))
        throw bad("飞书公开阅读跳转到了非飞书地址，已停止导入");
    },
  });
  readSignal.throwIfAborted();
  if (response.status !== 200) return null;
  const data = embeddedClientVars(response.text);
  if (!data) return null;
  const queue: string[] = [];
  const scheduled = new Set<string>();
  const completed = new Set<string>();
  let bytes = Buffer.byteLength(response.text);
  const schedule = (page: typeof data, current?: string) => {
    if (page.skip_blocks?.length)
      throw bad("飞书正文中有未提供的内容块，请授权应用或导出文件后导入");
    const cursors = page.next_cursors ?? [];
    if (page.has_more && !cursors.length) throw bad("飞书正文尚未读完，但缺少下一批地址，请重试");
    for (const cursor of cursors) {
      if (cursor === current || completed.has(cursor))
        throw bad("飞书正文分页游标重复，已停止读取，请重试");
      if (!scheduled.has(cursor)) {
        scheduled.add(cursor);
        queue.push(cursor);
      }
    }
    if (scheduled.size > 25 || Object.keys(data.block_map).length > 5000 || bytes > 16 * 1024 ** 2)
      throw bad("飞书文档超过读取上限，请拆分后导入；未保存不完整正文");
  };
  schedule(data);
  while (queue.length) {
    readSignal.throwIfAborted();
    const cursor = queue.shift()!;
    const endpoint = new URL("/space/api/docx/pages/client_vars", url.origin);
    endpoint.search = new URLSearchParams({
      id: data.id,
      mode: "7",
      limit: "239",
      cursor,
    }).toString();
    const pageResponse = await fetchSource(endpoint.href, {
      signal: readSignal,
      cookieJar,
      headers: { Accept: "application/json", Referer: url.href },
      onRequest: (target) => {
        if (target.origin !== url.origin) throw bad("飞书正文分页跳转到其他来源，已停止读取");
      },
    });
    readSignal.throwIfAborted();
    if (pageResponse.status !== 200)
      throw bad(`飞书后续正文读取失败（HTTP ${pageResponse.status}），请重试`);
    let value: unknown;
    try {
      value = JSON.parse(pageResponse.text);
    } catch {
      throw bad("飞书后续正文未返回有效数据，访客会话可能已过期，请重试");
    }
    const parsed = clientVarsSchema.safeParse(value);
    if (!parsed.success || parsed.data.code !== 0)
      throw bad("飞书后续正文读取失败或没有阅读权限，请重试或导出文件");
    const page = parsed.data.data;
    if (
      page.id !== data.id ||
      (data.structure_version !== undefined &&
        page.structure_version !== undefined &&
        page.structure_version !== data.structure_version)
    )
      throw bad("飞书文档在读取过程中发生变化，请重试以获取一致的完整正文");
    bytes += Buffer.byteLength(pageResponse.text);
    Object.assign(data.block_map, page.block_map);
    completed.add(cursor);
    schedule(page, cursor);
  }
  return renderDocument({ ...data, has_more: false, next_cursors: [] });
}
