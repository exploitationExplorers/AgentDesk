import type { InterviewImportItem, InterviewSettings } from "@agentdesk/shared";
import { Button, Dialog, Field, GlassTabMenu, Input, Textarea } from "@agentdesk/ui";
import { useMutation } from "@tanstack/react-query";
import { FileUp, Link2, Type } from "lucide-react";
import { useState } from "react";
import { interviewApi } from "./interview-api";

export function InterviewImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<"file" | "url" | "text">("file");
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      let items: InterviewImportItem[];
      if (mode === "file") {
        if (!files.length || files.length > 30) throw new Error("每批请选择 1～30 个文件");
        if (files.some((file) => file.size > 8 * 1024 ** 2)) throw new Error("单文件不能超过 8 MB");
        if (files.reduce((sum, file) => sum + file.size, 0) > 23 * 1024 ** 2)
          throw new Error("本批文件总大小不能超过 23 MB，请分批导入");
        items = await Promise.all(
          files.map(async (file): Promise<InterviewImportItem> => {
            const base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result).split(",")[1]!);
              reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
              reader.readAsDataURL(file);
            });
            return { kind: "file", name: file.name, base64 };
          }),
        );
      } else if (mode === "url") {
        const urls = [
          ...new Set(
            links
              .split(/\r?\n/)
              .map((url) => url.trim())
              .filter(Boolean),
          ),
        ];
        if (!urls.length || urls.length > 30) throw new Error("每批请输入 1～30 个链接，一行一个");
        for (const url of urls) {
          try {
            if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
          } catch {
            throw new Error(`链接格式不正确：${url.slice(0, 100)}`);
          }
        }
        items = urls.map((url) => ({ kind: "url", url }));
      } else {
        if (text.trim().length < 5 || text.length > 120_000)
          throw new Error("正文需为 5～120,000 字");
        items = [{ kind: "text", name: name.trim() || "粘贴的面试题", text }];
      }
      return interviewApi.import(items);
    },
    onSuccess: () => {
      onImported();
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
      title="导入面试资料"
      description="保留资料中的答案，缺少的答案由 AI 补齐并标明来源。"
      footer={
        <Button variant="brand" loading={mutation.isPending} onClick={() => mutation.mutate()}>
          开始导入
        </Button>
      }
    >
      <div className="space-y-4">
        <GlassTabMenu
          value={mode}
          onChange={setMode}
          label="导入方式"
          options={[
            {
              value: "file",
              label: (
                <>
                  <FileUp size={14} /> 文件
                </>
              ),
            },
            {
              value: "url",
              label: (
                <>
                  <Link2 size={14} /> 链接
                </>
              ),
            },
            {
              value: "text",
              label: (
                <>
                  <Type size={14} /> 文本
                </>
              ),
            },
          ]}
        />
        {mode === "file" ? (
          <>
            <label className="iv-upload">
              <FileUp className="h-8 w-8 text-brand" />
              <strong>选择文件，建立自己的题库</strong>
              <span>PDF · DOCX · MD · TXT · HTML · CSV · JSON</span>
              <input
                aria-label="面试资料文件"
                type="file"
                multiple
                accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.json"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </label>
            <p className="text-xs text-muted">
              每批最多 30 个文件，单个 8 MB，总计 23 MB。文本文件请用 UTF-8；扫描版 PDF 需先 OCR。
            </p>
            {files.length > 0 && (
              <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted">
                {files.map((file, i) => (
                  <li key={`${file.name}-${i}`}>
                    {file.name} · {(file.size / 1024).toFixed(0)} KB
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : mode === "url" ? (
          <Field
            label="资料链接"
            hint="一行一个。公开网页和飞书公开文档可直接导入，无需配置应用；飞书文件夹或非公开文档需在「学习设置」连接自建应用。"
          >
            <Textarea
              aria-label="资料链接"
              className="min-h-40"
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              placeholder={
                "https://example.com/interview\nhttps://your-team.feishu.cn/drive/folder/..."
              }
            />
          </Field>
        ) : (
          <>
            <Field label="资料名称">
              <Input
                aria-label="资料名称"
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：前端基础面试题"
              />
            </Field>
            <Field label="题目与答案" hint="推荐使用 Q: 与答案：分隔；也支持交给 AI 整理普通文本。">
              <Textarea
                aria-label="题目与答案"
                className="min-h-48"
                value={text}
                maxLength={120000}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "Q: 什么是闭包？\n答案：闭包是函数与其词法环境的组合。\n\nQ: 如何理解事件循环？"
                }
              />
            </Field>
          </>
        )}
        <p className="rounded-xl bg-surface-2 p-3 text-xs leading-relaxed text-muted">
          整理普通文本和补齐答案会使用你在设置中配置的模型。导入在后台继续，可以关闭窗口后查看每份资料的进度。
        </p>
        {mutation.error && (
          <p role="alert" className="text-sm text-danger">
            {mutation.error.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function InterviewSettingsDialog({
  settings,
  onClose,
  onSaved,
}: {
  settings: InterviewSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [goal, setGoal] = useState(String(settings.dailyGoal));
  const [appId, setAppId] = useState(settings.feishuAppId);
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const mutation = useMutation({
    mutationFn: () => {
      const dailyGoal = Number(goal);
      if (!Number.isInteger(dailyGoal) || dailyGoal < 1 || dailyGoal > 100)
        throw new Error("每日目标需为 1～100 道题");
      if (appId !== settings.feishuAppId && !secret && !clearSecret)
        throw new Error("更换 App ID 时请同时填写对应的 App Secret");
      return interviewApi.saveSettings({
        dailyGoal,
        feishuAppId: appId,
        ...(clearSecret ? { feishuAppSecret: "" } : secret ? { feishuAppSecret: secret } : {}),
      });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
      title="学习设置"
      description="设置每日目标，连接飞书面试资料。"
      footer={
        <Button variant="brand" loading={mutation.isPending} onClick={() => mutation.mutate()}>
          保存设置
        </Button>
      }
    >
      <div className="space-y-4">
        <Field
          label="每日目标题数"
          hint={`统计时区：${settings.timeZone}。同一天重复练习同一题只计 1 道。`}
        >
          <Input
            aria-label="每日目标题数"
            type="number"
            min={1}
            max={100}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </Field>
        <div className="border-t pt-4">
          <h3 className="mb-2 font-semibold">飞书连接</h3>
          <p className="text-xs leading-relaxed text-muted">
            在飞书开放平台创建并发布自建应用，开启云空间目录、云文档正文的读取权限；导入知识库链接还需知识库读取权限。将目标文件夹及文档共享给应用。只有
            App ID 和 Secret 而没有文档权限，仍然无法读取。
          </p>
        </div>
        <Field label="App ID">
          <Input
            aria-label="飞书 App ID"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            autoComplete="off"
            placeholder="cli_…"
          />
        </Field>
        <Field
          label="App Secret"
          hint={
            settings.hasFeishuSecret
              ? "已保存，留空保留现有凭据。"
              : "凭据加密保存，不会在页面回显。"
          }
        >
          <Input
            aria-label="飞书 App Secret"
            type="password"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setClearSecret(false);
            }}
            autoComplete="new-password"
          />
        </Field>
        {settings.hasFeishuSecret && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={clearSecret}
              onChange={(e) => setClearSecret(e.target.checked)}
            />
            移除已保存的飞书凭据
          </label>
        )}
        <p className="text-xs text-muted">
          无法获取应用授权时，可在飞书导出 DOCX / PDF
          后批量导入。飞书表格、附件和扫描图片暂不直接解析。
        </p>
        {mutation.error && (
          <p role="alert" className="text-sm text-danger">
            {mutation.error.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
