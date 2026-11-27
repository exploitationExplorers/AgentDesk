import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, FolderPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@agentdesk/shared";
import { Button, Card, Field, Input, Segmented, Select } from "@agentdesk/ui";
import { AppMark } from "../../components/AppMark";
import { api } from "../../lib/api";
import { saveAvatar } from "../../lib/avatar";
import { normalizeFolder, presentFolder } from "../../lib/paths";
import { toast } from "../../lib/toast";
import { checkForUpdates, isTauri } from "../../lib/tauri";
import { applyTheme, useUi, type Theme } from "../../stores/ui";

export function GeneralTab() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health });
  const { theme, setTheme } = useUi();
  const changeTheme = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
  };
  const [form, setForm] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (!data) return;
    setForm((current) =>
      current ? { ...current, scanRoots: data.scanRoots, avatar: data.avatar } : data,
    );
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

  const saveFolders = useMutation({
    mutationFn: (scanRoots: string[]) => api.updateSettings({ scanRoots }),
    onSuccess: (next) => {
      setForm((current) => (current ? { ...current, scanRoots: next.scanRoots } : next));
      queryClient.setQueryData<AppSettings>(["settings"], (prev) =>
        prev ? { ...prev, scanRoots: next.scanRoots } : next,
      );
    },
    onError: (error: Error) => toast(error.message || "文件夹没有保存", { tone: "danger" }),
  });

  if (!form) return null;

  const persist = () => save.mutate(form);

  return (
    <div className="grid max-w-3xl gap-5">
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <AppMark src={form.avatar} className="h-14 w-14 shrink-0 rounded-2xl" />
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
        <ProjectFolders
          folders={form.scanRoots}
          busy={saveFolders.isPending}
          onChange={(scanRoots, added) =>
            saveFolders.mutate(scanRoots, {
              onSuccess: () => {
                if (added) toast("已添加文件夹", { tone: "success" });
              },
            })
          }
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              onChange={changeTheme}
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

      <Card className="grid gap-2 break-words p-5 text-[12.5px] text-muted">
        <h3 className="text-[14px] font-semibold text-fg">关于</h3>
        <p>版本：{health.data?.version}</p>
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

function ProjectFolders({
  folders,
  busy,
  onChange,
}: {
  folders: string[];
  busy: boolean;
  onChange: (folders: string[], added: boolean) => void;
}) {
  const pick = useMutation({
    mutationFn: async () => {
      const picked = await api.pickProjectDirectory();
      return picked.path ? normalizeFolder(picked.path) : null;
    },
    onSuccess: (path) => {
      if (!path) return;
      if (folders.some((folder) => normalizeFolder(folder) === path)) {
        toast("这个文件夹已经添加过了");
        return;
      }
      onChange([...folders, path], true);
    },
    onError: (error: Error) => toast(error.message || "无法打开文件夹选择器", { tone: "danger" }),
  });

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-[12px] font-medium text-muted">项目文件夹</h4>
        <Button
          size="sm"
          variant="secondary"
          loading={pick.isPending}
          disabled={busy}
          onClick={() => pick.mutate()}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          添加文件夹
        </Button>
      </div>
      <p className="mb-3 text-[11.5px] leading-5 text-subtle">
        选择存放代码的文件夹。里面的 Git 仓库会显示在项目里。
      </p>
      {folders.length ? (
        <ul className="overflow-hidden rounded-xl border" aria-label="项目文件夹">
          {folders.map((folder) => {
            const { name, location } = presentFolder(folder);
            return (
              <li
                key={folder}
                className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
              >
                <Folder className="h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{name}</p>
                  {location ? (
                    <p className="truncate text-[11.5px] text-subtle" title={folder}>
                      {location}
                    </p>
                  ) : null}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`移除 ${name}`}
                  disabled={busy}
                  onClick={() =>
                    onChange(
                      folders.filter((item) => item !== folder),
                      false,
                    )
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed px-4 py-6 text-center">
          <p className="text-[13px] font-medium">还没有项目文件夹</p>
          <p className="mt-1 text-[12.5px] text-muted">添加后，项目页会找到这些位置里的仓库。</p>
        </div>
      )}
    </div>
  );
}
