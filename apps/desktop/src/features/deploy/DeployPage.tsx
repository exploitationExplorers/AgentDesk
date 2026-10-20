import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Pencil,
  Play,
  Plus,
  Rocket,
  Server as ServerIcon,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DeployRecipe, Server } from "@agentdesk/shared";
import { Badge, Button, Card, EmptyState, PageHeader, Segmented, Spinner, cn } from "@agentdesk/ui";
import { api } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { RecipeDialog } from "./RecipeDialog";
import { RUN_STATUS, RunPanel } from "./RunPanel";
import { ServerDialog } from "./ServerDialog";

function ServersView() {
  const queryClient = useQueryClient();
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers });
  const [editing, setEditing] = useState<Server | null | undefined>(undefined);
  const open = useMutation({ mutationFn: (id: string) => api.openServerPanel(id) });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["servers"] }),
  });

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="secondary" onClick={() => setEditing(null)}>
          <Plus className="h-3.5 w-3.5" />
          添加服务器
        </Button>
      </div>
      {servers.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {servers.data.map((s) => (
            <Card key={s.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-surface-2 text-muted">
                  <ServerIcon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold">{s.name}</p>
                  <p className="truncate font-mono text-[11.5px] text-subtle">{s.panelUrl}</p>
                  <div className="mt-2 flex gap-1.5">
                    <Badge>{s.username || "未设置用户名"}</Badge>
                    <Badge tone={s.hasPassword ? "success" : "warning"}>
                      {s.hasPassword ? "已保存密码" : "无密码"}
                    </Badge>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex gap-1.5 border-t pt-3">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={open.isPending && open.variables === s.id}
                  onClick={() => open.mutate(s.id)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  自动登录并打开面板
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<ServerIcon className="h-6 w-6" />}
          title="还没有服务器"
          description="添加宝塔面板地址和账号，之后可以一键自动登录、执行部署。"
          action={<Button onClick={() => setEditing(null)}>添加服务器</Button>}
        />
      )}
      {open.error ? <p className="mt-3 text-[12.5px] text-danger">{open.error.message}</p> : null}
      {editing !== undefined ? (
        <ServerDialog server={editing} onClose={() => setEditing(undefined)} />
      ) : null}
    </>
  );
}

function RecipesView() {
  const queryClient = useQueryClient();
  const recipes = useQuery({ queryKey: ["recipes"], queryFn: api.recipes });
  const servers = useQuery({ queryKey: ["servers"], queryFn: api.servers });
  const runs = useQuery({ queryKey: ["deploy-runs"], queryFn: () => api.deployRuns() });
  const [editing, setEditing] = useState<DeployRecipe | null | undefined>(undefined);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedRun && runs.data?.[0]) setSelectedRun(runs.data[0].id);
  }, [runs.data, selectedRun]);

  const run = useMutation({
    mutationFn: (id: string) => api.runRecipe(id),
    onSuccess: (r) => {
      setSelectedRun(r.id);
      void queryClient.invalidateQueries({ queryKey: ["deploy-runs"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRecipe(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
  });
  const serverName = (id: string) => servers.data?.find((s) => s.id === id)?.name ?? "未知服务器";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div>
        <div className="mb-3 flex items-center">
          <h2 className="text-[13px] font-semibold text-muted">部署配方</h2>
          <Button
            className="ml-auto"
            size="sm"
            variant="secondary"
            onClick={() => setEditing(null)}
            disabled={!servers.data?.length}
          >
            <Plus className="h-3.5 w-3.5" />
            新建
          </Button>
        </div>
        {recipes.isLoading ? <Spinner /> : null}
        <div className="grid gap-2">
          {recipes.data?.map((r) => (
            <Card key={r.id} className="p-3.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold">{r.name}</p>
                  <p className="truncate text-[11.5px] text-subtle">
                    {serverName(r.serverId)} · {r.steps.length} 步
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  loading={run.isPending && run.variables === r.id}
                  onClick={() => run.mutate(r.id)}
                >
                  <Play className="h-3 w-3 fill-current" />
                  部署
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setEditing(r)} aria-label="编辑">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => remove.mutate(r.id)}
                  aria-label="删除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
          {recipes.data?.length === 0 ? (
            <EmptyState
              title="还没有部署配方"
              description={
                servers.data?.length
                  ? "用 IM 等内置模板快速生成：拉代码、构建、重启、健康检查。"
                  : "先在“服务器”里添加宝塔服务器。"
              }
            />
          ) : null}
        </div>
        {run.error ? <p className="mt-2 text-[12.5px] text-danger">{run.error.message}</p> : null}

        <h2 className="mt-8 mb-3 text-[13px] font-semibold text-muted">运行记录</h2>
        <div className="grid gap-1">
          {runs.data?.slice(0, 15).map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelectedRun(r.id)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[12.5px]",
                selectedRun === r.id ? "bg-surface-2" : "hover:bg-surface-2/60",
              )}
            >
              <span className="truncate">{r.recipeName}</span>
              <Badge tone={RUN_STATUS[r.status].tone} className="ml-auto">
                {RUN_STATUS[r.status].label}
              </Badge>
              <span className="w-16 shrink-0 text-right text-[11px] text-subtle">
                {timeAgo(r.createdAt)}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div>
        {selectedRun ? (
          <RunPanel runId={selectedRun} />
        ) : (
          <EmptyState
            icon={<Rocket className="h-6 w-6" />}
            title="选择一个配方开始部署"
            description="每一步都有日志和截图，失败后可以从失败的步骤继续。"
          />
        )}
      </div>
      {editing !== undefined ? (
        <RecipeDialog recipe={editing} onClose={() => setEditing(undefined)} />
      ) : null}
    </div>
  );
}

export function DeployPage() {
  const [tab, setTab] = useState<"recipes" | "servers">("recipes");
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          icon={<Rocket className="h-5 w-5" />}
          title="自动部署"
          description="浏览器自动化登录宝塔面板，按配方执行部署，告别手动找链接、登录、点按钮"
          actions={
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "recipes", label: "配方与运行" },
                { value: "servers", label: "服务器" },
              ]}
            />
          }
        />
        {tab === "recipes" ? <RecipesView /> : <ServersView />}
      </div>
    </div>
  );
}
