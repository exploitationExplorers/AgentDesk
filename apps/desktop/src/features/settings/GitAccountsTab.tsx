import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Github, Trash2 } from "lucide-react";
import { useState } from "react";
import type { GitAccount } from "@agentdesk/shared";
import { Badge, Button, Card, Field, Input, Select } from "@agentdesk/ui";
import { api } from "../../lib/api";

const TOKEN_HELP: Record<GitAccount["platform"], string> = {
  github: "Settings → Developer settings → Personal access tokens，勾选 repo 只读即可",
  gitee: "设置 → 私人令牌，勾选 projects、pull_requests、issues",
  gitlab: "User Settings → Access Tokens，勾选 read_api；主机填公司 GitLab 域名",
};

export function GitAccountsTab() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["git-accounts"], queryFn: api.gitAccounts });
  const [form, setForm] = useState<{
    platform: GitAccount["platform"];
    host: string;
    token: string;
  }>({ platform: "github", host: "", token: "" });
  const save = useMutation({
    mutationFn: () =>
      api.saveGitAccount({
        platform: form.platform,
        host: form.host || undefined,
        token: form.token || undefined,
      }),
    onSuccess: () => {
      setForm({ ...form, token: "", host: "" });
      void queryClient.invalidateQueries({ queryKey: ["git-accounts"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteGitAccount(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["git-accounts"] }),
  });

  return (
    <div className="grid gap-5">
      <p className="text-[13px] text-muted">
        Token 用于拉取 PR/MR 和 Issue。添加 GitLab 主机后，remote 指向该域名的项目会被识别为
        GitLab。
      </p>
      {data.length ? (
        <Card>
          {data.map((a) => (
            <div
              key={`${a.platform}:${a.host}`}
              className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
            >
              <Github className="h-4 w-4 text-muted" />
              <span className="text-[13px] font-medium capitalize">{a.platform}</span>
              <span className="font-mono text-[12px] text-subtle">{a.host}</span>
              <Badge tone={a.hasToken ? "success" : "warning"}>
                {a.hasToken ? "已配置 Token" : "无 Token"}
              </Badge>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto"
                onClick={() => remove.mutate(`${a.platform}:${a.host.toLowerCase()}`)}
                aria-label="删除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </Card>
      ) : null}
      <Card className="p-4">
        <div className="grid grid-cols-[140px_1fr] gap-4">
          <Field label="平台">
            <Select
              value={form.platform}
              onChange={(e) =>
                setForm({ ...form, platform: e.target.value as GitAccount["platform"] })
              }
            >
              <option value="github">GitHub</option>
              <option value="gitee">Gitee</option>
              <option value="gitlab">GitLab（自建）</option>
            </Select>
          </Field>
          <Field
            label="主机"
            hint={form.platform === "gitlab" ? "例如 gitlab.company.com" : "留空使用默认域名"}
          >
            <Input
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder={
                form.platform === "gitlab"
                  ? "gitlab.company.com"
                  : form.platform === "gitee"
                    ? "gitee.com"
                    : "github.com"
              }
            />
          </Field>
          <Field label="Token" hint={TOKEN_HELP[form.platform]} className="col-span-2">
            <Input
              type="password"
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            保存账号
          </Button>
          {save.error ? (
            <span className="text-[12px] text-danger">{save.error.message}</span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
