import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Server } from "@agentdesk/shared";
import { Button, Dialog, Field, Input, Textarea } from "@agentdesk/ui";
import { api } from "../../lib/api";

export function ServerDialog({ server, onClose }: { server: Server | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: server?.name ?? "",
    panelUrl: server?.panelUrl ?? "",
    username: server?.username ?? "",
    password: "",
    notes: server?.notes ?? "",
  });
  const save = useMutation({
    mutationFn: () => api.saveServer({ ...form, password: form.password || undefined }, server?.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      onClose();
    },
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={server ? "编辑服务器" : "添加宝塔服务器"}
      description="密码加密保存在本地，只在自动登录时使用。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => save.mutate()}
            disabled={!form.name || !form.panelUrl}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="名称">
          <Input value={form.name} onChange={set("name")} placeholder="IM 生产服" autoFocus />
        </Field>
        <Field label="面板地址（含安全入口）" hint="例如 https://1.2.3.4:8888/abcd1234">
          <Input value={form.panelUrl} onChange={set("panelUrl")} placeholder="https://" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="用户名">
            <Input value={form.username} onChange={set("username")} />
          </Field>
          <Field label="密码" hint={server?.hasPassword ? "已保存，留空则不修改" : undefined}>
            <Input
              type="password"
              value={form.password}
              onChange={set("password")}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <Field label="备注">
          <Textarea value={form.notes} onChange={set("notes")} />
        </Field>
        {save.error ? <p className="text-[12.5px] text-danger">{save.error.message}</p> : null}
      </div>
    </Dialog>
  );
}
