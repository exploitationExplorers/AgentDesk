import { AppError, ErrorCode, type InterviewImportItem } from "@agentdesk/shared";
import { z } from "zod";
import type { SecretStore } from "../secrets";
import { articleText } from "./insight-source";
import { fetchPublicSource, publicSourceUrl } from "./public-fetch";
import { readFeishuPublicDocument } from "./feishu-public";

export interface InterviewDocument {
  name: string;
  origin: string;
  text: string;
}
export interface InterviewDocuments {
  documents: InterviewDocument[];
  warnings: string[];
}
const MAX_TEXT = 120_000;
export const FEISHU_ID = "interview:feishu-app-id";
export const FEISHU_SECRET = "interview:feishu-app-secret";
const bad = (message: string) => new AppError(ErrorCode.BadRequest, message);

function checkedText(text: string): string {
  if (text.trim().length < 5) throw bad("未读取到正文。扫描版 PDF 请先 OCR，或粘贴题目文本。");
  if (text.length > MAX_TEXT) throw bad("单份资料超过 12 万字，请拆成多个文件后导入；未截断原文。");
  return text.trim();
}

export class InterviewSourceReader {
  constructor(
    private readonly secrets: Pick<SecretStore, "get">,
    private readonly fetchSource = fetchPublicSource,
  ) {}

  async read(input: InterviewImportItem, signal: AbortSignal): Promise<InterviewDocuments> {
    if (input.kind === "text")
      return {
        documents: [{ name: input.name, origin: "粘贴文本", text: checkedText(input.text) }],
        warnings: [],
      };
    if (input.kind === "file") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw bad("文件编码无效");
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.length > 8 * 1024 ** 2) throw bad("单文件不能超过 8 MB");
      const ext = input.name.split(".").at(-1)?.toLowerCase();
      let text: string;
      if (ext === "docx") {
        const { extractRawText } = await import("mammoth");
        text = (await extractRawText({ buffer: bytes })).value;
      } else if (ext === "pdf") {
        const { extractText, getDocumentProxy } = await import("unpdf");
        const document = await getDocumentProxy(new Uint8Array(bytes));
        try {
          if (document.numPages > 300) throw bad("PDF 超过 300 页，请拆分后导入");
          // mergePages 会折叠全部空白，导致题目与答案标记挤在同一行。
          text = (await extractText(document, { mergePages: false })).text.join("\n\n");
        } finally {
          await document.destroy();
        }
      } else if (["txt", "md", "markdown", "csv", "json", "html", "htm"].includes(ext ?? "")) {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (ext === "html" || ext === "htm") text = articleText(text, "text/html");
        if (ext === "json") {
          const result = z
            .array(z.object({ question: z.string(), answer: z.string().optional() }))
            .safeParse(JSON.parse(text));
          if (result.success)
            text = result.data.map((q) => `Q: ${q.question}\n答案：${q.answer ?? ""}`).join("\n\n");
        }
      } else throw bad("暂不支持此格式，请使用 PDF、DOCX、MD、TXT、HTML、CSV 或 JSON 文件");
      signal.throwIfAborted();
      return {
        documents: [{ name: input.name, origin: input.name, text: checkedText(text) }],
        warnings: [],
      };
    }
    const url = publicSourceUrl(input.url);
    if (
      /(?:^|\.)feishu\.cn$/.test(url.hostname) &&
      /\/(?:drive\/folder|docx|docs|wiki)\//.test(url.pathname)
    ) {
      return this.feishu(url, signal);
    }
    const response = await this.fetchSource(url.href, { signal });
    if (response.status >= 400)
      throw bad(`链接读取失败（HTTP ${response.status}），请检查分享权限或导出文件`);
    if (!/text\/|application\/(?:json|xhtml)/i.test(response.contentType))
      throw bad("此链接不是网页正文，请下载文件后批量导入");
    if (/suite-passport|window\.passport|登录后查看|无权访问|请求访问权限/.test(response.text))
      throw bad("链接需要登录或授权，请开放阅读权限或导出文件后导入");
    return {
      documents: [
        {
          name: input.name || url.hostname,
          origin: url.href,
          text: checkedText(articleText(response.text, response.contentType)),
        },
      ],
      warnings: [],
    };
  }

  private async feishu(url: URL, signal: AbortSignal): Promise<InterviewDocuments> {
    const appId = this.secrets.get(FEISHU_ID);
    const appSecret = this.secrets.get(FEISHU_SECRET);
    let publicError: string | undefined;
    if (!url.pathname.includes("/drive/folder/")) {
      try {
        const document = await readFeishuPublicDocument(url, signal, this.fetchSource);
        if (document)
          return {
            documents: [{ ...document, origin: url.href, text: checkedText(document.text) }],
            warnings: [],
          };
      } catch (error) {
        signal.throwIfAborted();
        publicError = error instanceof Error ? error.message : "公开文档读取失败";
      }
    }
    if (!appId || !appSecret) {
      throw bad(
        publicError
          ? `飞书公开阅读未完成：${publicError}。可重试，或在「学习设置 → 飞书连接」授权应用／导出文件后导入。`
          : "飞书文件夹／非公开文档需要授权。公开文档无需配置应用；请检查匿名访问权限，或在「学习设置 → 飞书连接」配置自建应用并将文档授权给应用，也可导出文件后批量导入。",
      );
    }
    const auth = await this.fetchSource(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal,
      },
    );
    const tokenData = z
      .object({ code: z.number(), tenant_access_token: z.string().optional() })
      .parse(JSON.parse(auth.text));
    if (tokenData.code !== 0 || !tokenData.tenant_access_token)
      throw bad("飞书应用认证失败，请检查 App ID、App Secret 和应用发布状态");
    const api = async (path: string): Promise<Record<string, unknown>> => {
      const response = await this.fetchSource(`https://open.feishu.cn/open-apis/${path}`, {
        signal,
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
      });
      const parsed = z
        .object({ code: z.number(), data: z.record(z.string(), z.unknown()).optional() })
        .parse(JSON.parse(response.text));
      if (response.status >= 400 || parsed.code !== 0 || !parsed.data)
        throw bad(`飞书读取失败（code ${parsed.code}），请检查应用的云文档读取权限及文件共享授权`);
      return parsed.data;
    };
    const match = /\/(drive\/folder|docx|docs|wiki)\/([A-Za-z0-9]+)/.exec(url.pathname);
    if (!match) throw bad("无法识别飞书文档地址");
    const docs: InterviewDocument[] = [];
    const warnings: string[] = [];
    const visited = new Set<string>();
    let itemsSeen = 0;
    const visit = async (
      type: string,
      token: string,
      name: string,
      depth: number,
    ): Promise<void> => {
      if (visited.has(`${type}:${token}`)) return;
      visited.add(`${type}:${token}`);
      if (++itemsSeen > 100 || depth > 5) {
        warnings.push("目录超过 100 项或 5 层，剩余资料请分批导入");
        return;
      }
      if (type === "folder" || type === "drive/folder") {
        let pageToken = "";
        const pages = new Set<string>();
        do {
          if (pages.has(pageToken)) throw bad("飞书分页游标重复，已停止读取");
          pages.add(pageToken);
          const data = z
            .object({
              files: z.array(z.object({ token: z.string(), name: z.string(), type: z.string() })),
              has_more: z.boolean().optional(),
              next_page_token: z.string().optional(),
            })
            .parse(
              await api(
                `drive/v1/files?folder_token=${encodeURIComponent(token)}&page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`,
              ),
            );
          for (const file of data.files) {
            if (itemsSeen >= 100) {
              warnings.push("目录达到 100 项上限，请分批导入剩余资料");
              return;
            }
            try {
              await visit(file.type, file.token, file.name, depth + 1);
            } catch (error) {
              warnings.push(`${file.name}：${error instanceof Error ? error.message : "读取失败"}`);
            }
          }
          pageToken = data.has_more ? (data.next_page_token ?? "") : "";
          if (data.has_more && !pageToken) throw bad("飞书缺少下一页游标，目录未读取完整");
        } while (pageToken);
      } else if (type === "wiki") {
        const data = z
          .object({
            node: z.object({
              obj_type: z.string(),
              obj_token: z.string(),
              title: z.string().optional(),
            }),
          })
          .parse(await api(`wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`));
        await visit(data.node.obj_type, data.node.obj_token, data.node.title ?? name, depth + 1);
      } else if (type === "docx" || type === "doc" || type === "docs") {
        const path =
          type === "docx"
            ? `docx/v1/documents/${encodeURIComponent(token)}/raw_content`
            : `doc/v2/${encodeURIComponent(token)}/raw_content`;
        const data = z.object({ content: z.string() }).parse(await api(path));
        docs.push({
          name,
          origin: `${url.origin}/${type === "docx" ? "docx" : "docs"}/${token}`,
          text: checkedText(data.content),
        });
      } else warnings.push(`${name}：${type} 类型请导出为 PDF／DOCX／文本再导入`);
    };
    await visit(match[1]!, match[2]!, url.pathname.split("/").at(-1)!, 0);
    if (!docs.length)
      throw bad(
        warnings.join("；").slice(0, 1000) ||
          "飞书目录中没有可读取文档，请检查应用对该文件夹的权限",
      );
    return { documents: docs, warnings: [...new Set(warnings)] };
  }
}
