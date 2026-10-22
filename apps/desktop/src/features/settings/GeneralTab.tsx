import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@agentdesk/shared";
import { Button, Card, Field, Input, Segmented, Select, Textarea } from "@agentdesk/ui";
import { AppMark } from "../../components/AppMark";
import { api } from "../../lib/api";
import { saveAvatar } from "../../lib/avatar";
import { toast } from "../../lib/toast";
import { checkForUpdates, isTauri } from "../../lib/tauri";
import { useUi } from "../../stores/ui";

export function GeneralTab() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const { theme, setTheme } = useUi();
  const [form, setForm] = useState<AppSettings | null>(null);
  /** 单独编辑，避免 onChange 时 filter 空行导致无法按回车换行 */
  const [scanRootsText, setScanRootsText] = useState("");
  useEffect(() => {
    if (data) {
      setForm(data);
      setScanRootsText(data.scanRoots.join("\n"));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (s: AppSettings) => api.updateSettings(s),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["health"] });
    },
  });
  const update = useMutation({ mutationFn: checkForUpdates });
  const avatarInput = useRef<HTMLInputElement>(null);
  const avatar = useMutation({
    mutationFn: saveAvatar,
    onSuccess: (next) => {
      queryClient.setQueryData(["settings"], next);
      setForm(next);
      toast(next.avatar ? "头像已更新" : "已恢复默认图标", { tone: "success" });
    },
    onError: (error: Error) => toast(error.message || "头像更新失败", { tone: "danger" }),
  });

  if (!form) return null;

  const persist = () => {
    const scanRoots = scanRootsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    save.mutate({ ...form, scanRoots });
  };

  return (
    <div className="grid max-w-3xl gap-5">
      <Card className="flex items-center gap-4 p-5">
        <AppMark src={form.avatar} className="h-14 w-14 rounded-2xl" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">头像</h3>
          <p className="mt-1 text-[12.5px] text-subtle">
            显示在侧栏和首页。也可以直接点侧栏左上角的图标更换。
          </p>
        </div>
        <input
          ref={avatarInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) avatar.mutate(file);
          }}
        />
        <Button
          variant="secondary"
          loading={avatar.isPending && avatar.variables !== null}
          onClick={() => avatarInput.current?.click()}
        >
          导入头像
        </Button>
        {form.avatar ? (
          <Button variant="ghost" disabled={avatar.isPending} onClick={() => avatar.mutate(null)}>
            恢复默认
          </Button>
        ) : null}
      </Card>
      <Card className="grid gap-4 p-5">
        <h3 className="text-[14px] font-semibold">项目</h3>
        <Field
          label="扫描目录（每行一个）"
          hint="会递归查找最多 4 层内的 Git 仓库，自动识别 GitHub / Gitee / GitLab。按 Enter 换行后点保存。"
        >
          <Textarea
            value={scanRootsText}
            onChange={(e) => setScanRootsText(e.target.value)}
            rows={4}
            placeholder={"D:\\agent\nD:\\jiedan\nD:\\qushiyun\\new"}
            className="font-mono text-[12.5px]"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Cursor 命令">
            <Input
              value={form.cursorCommand}
              onChange={(e) => setForm({ ...form, cursorCommand: e.target.value })}
            />
          </Field>
          <Field label="Claude Code 命令">
            <Input
              value={form.claudeCommand}
              onChange={(e) => setForm({ ...form, claudeCommand: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      <Card className="grid gap-4 p-5">
        <h3 className="text-[14px] font-semibold">热榜与网络</h3>
        <div className="grid grid-cols-2 gap-4">
          <Field label="每日刷新时间" hint="到点自动抓取并生成速览；错过会在下次启动时补跑">
            <Input
              type="time"
              value={form.feedSchedule}
              onChange={(e) => setForm({ ...form, feedSchedule: e.target.value })}
            />
          </Field>
          <Field label="GitHub Trending 语言" hint="逗号分隔，留空项表示全部语言">
            <Input
              value={form.feedLanguages.map((l) => l || "all").join(", ")}
              onChange={(e) =>
                setForm({
                  ...form,
                  feedLanguages: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .map((s) => (s === "all" ? "" : s)),
                })
              }
            />
          </Field>
        </div>
        <Field
          label="HTTP 代理"
          hint={`留空时自动使用系统代理。当前生效：${health.data?.proxy ?? "无"}`}
        >
          <Input
            value={form.proxy}
            onChange={(e) => setForm({ ...form, proxy: e.target.value })}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>
      </Card>

      <Card className="grid gap-4 p-5">
        <h3 className="text-[14px] font-semibold">部署与外观</h3>
        <div className="grid grid-cols-2 gap-4">
          <Field label="自动化浏览器" hint="使用系统已安装的浏览器，无需额外下载">
            <Select
              value={form.browserChannel}
              onChange={(e) =>
                setForm({
                  ...form,
                  browserChannel: e.target.value as AppSettings["browserChannel"],
                })
              }
            >
              <option value="msedge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
            </Select>
          </Field>
          <Field label="主题">
            <Segmented
              value={theme}
              onChange={setTheme}
              options={[
                { value: "dark", label: "深色" },
                { value: "light", label: "浅色" },
                { value: "system", label: "跟随系统" },
              ]}
            />
          </Field>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" loading={save.isPending} onClick={persist}>
          保存设置
        </Button>
        {save.isSuccess ? <span className="text-[12px] text-success">已保存</span> : null}
        {save.error ? <span className="text-[12px] text-danger">{save.error.message}</span> : null}
      </div>

      <Card className="grid gap-2 p-5 text-[12.5px] text-muted">
        <h3 className="text-[14px] font-semibold text-fg">关于</h3>
        <p>版本：{health.data?.version}</p>
        <p>数据目录：{health.data?.dataDir}</p>
        <p>
          密钥保护：
          {health.data?.secretBackend === "keychain"
            ? "系统钥匙串（Windows 凭据管理器）"
            : "开发模式密钥文件"}
        </p>
        {isTauri() ? (
          <div className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              loading={update.isPending}
              onClick={() => update.mutate()}
            >
              检查更新
            </Button>
            {update.isSuccess && !update.data ? (
              <span className="ml-3 text-success">已是最新版本</span>
            ) : null}
            {update.error ? <span className="ml-3 text-danger">{update.error.message}</span> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
